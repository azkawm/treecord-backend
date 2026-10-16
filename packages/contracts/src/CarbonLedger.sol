// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {RoleGated, TreecordRoles} from "./TreecordRoles.sol";
import {ICampaign} from "./interfaces/ICampaign.sol";
import {ICampaignFactory} from "./interfaces/ICampaignFactory.sol";
import {ICarbonLedger} from "./interfaces/ICarbonLedger.sol";
import {
    CampaignStatus,
    CarbonBatch,
    Retirement,
    EmptyBeneficiary,
    EstimateLocked,
    InsufficientInventory,
    NoReservation,
    NonTransferable,
    PriceNotSet,
    UnknownBatch,
    UnknownCampaign,
    WrongCampaignStatus,
    ZeroAddress,
    ZeroAmount
} from "./libraries/TreecordTypes.sol";

/// @title CarbonLedger
/// @notice Non-transferable carbon credit ledger. ERC-1155 where token id = batch id and one unit = 1 kg CO2e
///         (1000 units = 1 tCO2e). Mirrors registry issuance; the registries (SRN PPI, Verra) remain the issuers.
/// @dev Balances move only along these paths, enforced in `_update`:
///      - mint: issuance allocation to reservation holders and to platform inventory
///      - sale: from platform inventory to a buyer
///      - burn: retirement by the holder
///      Any other transfer reverts with NonTransferable, and approvals are disabled. This avoids a secondary
///      market (PRODUCT_KNOWLEDGE.md section 3).
///
///      Platform inventory is held by this contract, not the treasury wallet. A treasury change therefore never
///      strands inventory, and the treasury does not need to accept ERC-1155 tokens. Sale proceeds go to the
///      current treasury.
///
///      Mints and sales skip the ERC-1155 receiver hook. These are ledger entries that can never be moved, so the
///      hook adds nothing, and a holder contract without the hook could otherwise block a whole issuance.
///
///      setEstimate and issueBatch loop over a campaign's contributors. That is fine for MVP campaign sizes.
contract CarbonLedger is ICarbonLedger, ERC1155, RoleGated, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    /// @notice Per-campaign carbon accounting.
    /// @param estimatedAmount Pre-certification estimate.
    /// @param reservedTotal Sum of all reservations (filled plus unfilled).
    /// @param outstanding Sum of unfilled reservations.
    /// @param issuedAmount Total mirrored from registry issuance.
    /// @param issuanceStarted True after the first batch. Locks the estimate.
    struct CampaignCarbon {
        uint256 estimatedAmount;
        uint256 reservedTotal;
        uint256 outstanding;
        uint256 issuedAmount;
        bool issuanceStarted;
    }

    /// @notice Carbon units per whole tonne (3 decimals).
    uint256 public constant UNITS_PER_TONNE = 1000;

    /// @notice The USDC token used for purchases.
    IERC20 public immutable usdc;

    /// @notice Number of batches issued. Also the latest batch id.
    uint256 public batchCount;
    /// @notice Number of retirements. Also the latest retirement id.
    uint256 public retirementCount;

    /// @notice Carbon accounting per campaign.
    mapping(address campaign => CampaignCarbon carbon) public campaignCarbon;
    /// @inheritdoc ICarbonLedger
    mapping(address campaign => mapping(address holder => uint256 amount)) public reservationOf;
    /// @notice Amount of a holder's reservation already filled by issuance.
    mapping(address campaign => mapping(address holder => uint256 amount)) public allocatedOf;
    /// @notice True once a holder declined their reservation for a campaign.
    mapping(address campaign => mapping(address holder => bool declined)) public declined;

    mapping(uint256 batchId => CarbonBatch batch) internal _batches;
    mapping(uint256 retirementId => Retirement retirement) internal _retirements;

    /// @param roles_ Central role registry.
    /// @param usdc_ USDC token.
    /// @param uri_ ERC-1155 metadata URI pattern, for example "https://treecord.app/api/carbon/batches/{id}.json".
    constructor(TreecordRoles roles_, IERC20 usdc_, string memory uri_) ERC1155(uri_) RoleGated(roles_) {
        if (address(usdc_) == address(0)) revert ZeroAddress();
        usdc = usdc_;
    }

    // =======================================================================
    // Reservations
    // =======================================================================

    /// @inheritdoc ICarbonLedger
    /// @dev Operator only. The campaign must be Active. Can be replaced until the first batch is issued.
    ///      Each contributor who has not declined gets `estimatedAmount * contribution / totalRaised`.
    ///      Rounding remainders are not reserved and go to platform inventory at issuance.
    // Loops over the campaign's contributors via view calls to our own Campaign clone (see contract notes).
    // forge-lint: disable-next-item(calls-loop)
    function setEstimate(address campaign, uint256 estimatedAmount) external onlyRoleHolder(OPERATOR_ROLE) {
        _requireCampaign(campaign);
        CampaignStatus status = ICampaign(campaign).status();
        if (status != CampaignStatus.Active) revert WrongCampaignStatus(CampaignStatus.Active, status);

        CampaignCarbon storage carbon = campaignCarbon[campaign];
        if (carbon.issuanceStarted) revert EstimateLocked(campaign);

        uint256 totalRaised = ICampaign(campaign).totalRaised();
        uint256 count = ICampaign(campaign).contributorCount();
        uint256 reservedTotal = 0;
        for (uint256 i = 0; i < count; ++i) {
            address holder = ICampaign(campaign).contributorAt(i);
            if (declined[campaign][holder]) continue;
            uint256 amount = (estimatedAmount * ICampaign(campaign).contributions(holder)) / totalRaised;
            reservationOf[campaign][holder] = amount;
            reservedTotal += amount;
            emit Reserved(campaign, holder, amount);
        }

        carbon.estimatedAmount = estimatedAmount;
        carbon.reservedTotal = reservedTotal;
        carbon.outstanding = reservedTotal;
        emit EstimateSet(campaign, estimatedAmount);
    }

    /// @inheritdoc ICarbonLedger
    /// @dev Credits already allocated stay with the holder. Only the unfilled part is released.
    function declineReservation(address campaign) external {
        uint256 allocated = allocatedOf[campaign][msg.sender];
        uint256 unfilled = reservationOf[campaign][msg.sender] - allocated;
        if (unfilled == 0) revert NoReservation(campaign, msg.sender);

        CampaignCarbon storage carbon = campaignCarbon[campaign];
        reservationOf[campaign][msg.sender] = allocated;
        declined[campaign][msg.sender] = true;
        carbon.reservedTotal -= unfilled;
        carbon.outstanding -= unfilled;
        emit ReservationDeclined(campaign, msg.sender, unfilled);
    }

    // =======================================================================
    // Issuance and sale
    // =======================================================================

    /// @inheritdoc ICarbonLedger
    /// @dev Issuer only. The campaign must be Active or Completed. Allocation order:
    ///      1. Reservation holders, pro rata to their unfilled reservation, capped by it. If the batch covers all
    ///         unfilled reservations, every holder is filled exactly.
    ///      2. The rest (including rounding remainders below one unit per holder) to platform inventory.
    function issueBatch(
        address campaign,
        string calldata registry,
        string calldata serialStart,
        string calldata serialEnd,
        uint16 vintage,
        uint256 amount
    ) external onlyRoleHolder(ISSUER_ROLE) returns (uint256 batchId) {
        _requireCampaign(campaign);
        CampaignStatus status = ICampaign(campaign).status();
        if (status != CampaignStatus.Active && status != CampaignStatus.Completed) {
            revert WrongCampaignStatus(CampaignStatus.Active, status);
        }
        if (amount == 0) revert ZeroAmount();

        batchId = ++batchCount;
        _batches[batchId] = CarbonBatch({
            campaign: campaign,
            vintage: vintage,
            amount: amount,
            priceUsdcPerTonne: 0,
            registry: registry,
            serialStart: serialStart,
            serialEnd: serialEnd
        });

        CampaignCarbon storage carbon = campaignCarbon[campaign];
        carbon.issuanceStarted = true;
        carbon.issuedAmount += amount;
        emit BatchIssued(batchId, campaign, registry, serialStart, serialEnd, vintage, amount);

        uint256 toHolders = _allocateToHolders(campaign, batchId, amount, carbon);
        uint256 toInventory = amount - toHolders;
        if (toInventory > 0) {
            _move(address(0), address(this), batchId, toInventory);
            emit Allocated(batchId, address(this), toInventory);
        }
    }

    /// @inheritdoc ICarbonLedger
    /// @dev Operator only.
    function setPrice(uint256 batchId, uint256 usdcPerTonne) external onlyRoleHolder(OPERATOR_ROLE) {
        _requireBatch(batchId);
        _batches[batchId].priceUsdcPerTonne = usdcPerTonne;
        emit PriceSet(batchId, usdcPerTonne);
    }

    /// @inheritdoc ICarbonLedger
    /// @dev Cost = amount * price / 1000, rounded up so fractional tonnes never undercharge.
    ///      The buyer must approve USDC to this contract first.
    function buy(uint256 batchId, uint256 amount) external nonReentrant returns (uint256 usdcPaid) {
        _requireBatch(batchId);
        if (amount == 0) revert ZeroAmount();
        uint256 price = _batches[batchId].priceUsdcPerTonne;
        if (price == 0) revert PriceNotSet(batchId);
        uint256 available = balanceOf(address(this), batchId);
        if (amount > available) revert InsufficientInventory(batchId, amount, available);

        usdcPaid = Math.mulDiv(amount, price, UNITS_PER_TONNE, Math.Rounding.Ceil);
        _move(address(this), msg.sender, batchId, amount);
        // _move skips the receiver hook, so no external call precedes this event. The function is also nonReentrant.
        // forge-lint: disable-next-line(reentrancy-events)
        emit Purchased(batchId, msg.sender, amount, usdcPaid);

        usdc.safeTransferFrom(msg.sender, roles.treasury(), usdcPaid);
    }

    // =======================================================================
    // Retirement
    // =======================================================================

    /// @inheritdoc ICarbonLedger
    /// @dev Burns from the caller. The matching registry retirement happens off-chain (tracked by the backend).
    function retire(uint256 batchId, uint256 amount, string calldata beneficiary, string calldata purpose)
        external
        returns (uint256 retirementId)
    {
        _requireBatch(batchId);
        if (amount == 0) revert ZeroAmount();
        if (bytes(beneficiary).length == 0) revert EmptyBeneficiary();

        _move(msg.sender, address(0), batchId, amount);
        retirementId = ++retirementCount;
        _retirements[retirementId] = Retirement({
            batchId: batchId,
            holder: msg.sender,
            amount: amount,
            // casting to 'uint64' is safe because block timestamps fit in 64 bits for billions of years
            // forge-lint: disable-next-line(unsafe-typecast)
            retiredAt: uint64(block.timestamp),
            beneficiary: beneficiary,
            purpose: purpose
        });
        emit Retired(retirementId, batchId, msg.sender, amount, beneficiary, purpose);
    }

    // =======================================================================
    // Admin
    // =======================================================================

    /// @notice Updates the ERC-1155 metadata URI pattern. Admin only.
    /// @param newUri The new URI pattern, with `{id}` substituted by clients.
    function setURI(string calldata newUri) external onlyRoleHolder(DEFAULT_ADMIN_ROLE) {
        _setURI(newUri);
    }

    /// @notice Approvals are disabled because credits cannot be transferred between users.
    function setApprovalForAll(address, bool) public pure override {
        revert NonTransferable();
    }

    // =======================================================================
    // Views
    // =======================================================================

    /// @inheritdoc ICarbonLedger
    function remainingReservation(address campaign, address holder) external view returns (uint256) {
        return reservationOf[campaign][holder] - allocatedOf[campaign][holder];
    }

    /// @inheritdoc ICarbonLedger
    function inventoryOf(uint256 batchId) external view returns (uint256) {
        return balanceOf(address(this), batchId);
    }

    /// @inheritdoc ICarbonLedger
    function getBatch(uint256 batchId) external view returns (CarbonBatch memory) {
        return _batches[batchId];
    }

    /// @inheritdoc ICarbonLedger
    function getRetirement(uint256 retirementId) external view returns (Retirement memory) {
        return _retirements[retirementId];
    }

    // =======================================================================
    // Internals
    // =======================================================================

    /// @dev Only mint, sale from inventory, and burn may move balances. Reached from the allocation loop only
    ///      for mints, which always pass this check.
    // forge-lint: disable-next-item(require-revert-in-loop)
    function _update(address from, address to, uint256[] memory ids, uint256[] memory values) internal override {
        if (from != address(0) && to != address(0) && from != address(this)) revert NonTransferable();
        super._update(from, to, ids, values);
    }

    // forge-lint: disable-next-item(calls-loop)
    function _allocateToHolders(address campaign, uint256 batchId, uint256 amount, CampaignCarbon storage carbon)
        internal
        returns (uint256 distributed)
    {
        uint256 outstanding = carbon.outstanding;
        if (outstanding == 0) return 0;
        uint256 toHolders = amount < outstanding ? amount : outstanding;
        bool fillsAll = toHolders == outstanding;

        uint256 count = ICampaign(campaign).contributorCount();
        for (uint256 i = 0; i < count; ++i) {
            address holder = ICampaign(campaign).contributorAt(i);
            uint256 unfilled = reservationOf[campaign][holder] - allocatedOf[campaign][holder];
            if (unfilled == 0) continue;

            uint256 share = fillsAll ? unfilled : (toHolders * unfilled) / outstanding;
            if (share == 0) continue;

            allocatedOf[campaign][holder] += share;
            distributed += share;
            _move(address(0), holder, batchId, share);
            emit Allocated(batchId, holder, share);
        }
        carbon.outstanding = outstanding - distributed;
    }

    /// @dev Moves one token id without the ERC-1155 receiver hook (see contract notes).
    function _move(address from, address to, uint256 id, uint256 amount) internal {
        uint256[] memory ids = new uint256[](1);
        uint256[] memory values = new uint256[](1);
        ids[0] = id;
        values[0] = amount;
        _update(from, to, ids, values);
    }

    function _requireCampaign(address campaign) internal view {
        if (!ICampaignFactory(roles.factory()).isCampaign(campaign)) revert UnknownCampaign(campaign);
    }

    function _requireBatch(uint256 batchId) internal view {
        if (batchId == 0 || batchId > batchCount) revert UnknownBatch(batchId);
    }
}
