import { getDeployment } from "@treecord/shared";
import { describe, expect, it } from "vitest";
import { InvalidPayloadError, operatorCall } from "./calls.js";

const deployment = getDeployment(31337);

describe("operatorCall", () => {
  it("builds setPrice for set_price jobs from the operator wallet", () => {
    const call = operatorCall("set_price", { batchId: "3", usdcPerTonne: "2500000" }, deployment);
    expect(call.wallet).toBe("operator");
    expect(call.description).toBe("setPrice(3, 2500000)");
  });

  it("fails a malformed payload without retrying", () => {
    expect(() => operatorCall("set_price", { batchId: "3" }, deployment)).toThrow(
      InvalidPayloadError,
    );
    expect(() => operatorCall("score", { submissionId: "x" }, deployment)).toThrow(
      "not sent by the operator lane",
    );
  });
});
