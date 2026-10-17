import { bytesToBase64Url, jwkThumbprint, type EcPublicJwk } from "@treecord/shared";

export interface TestDevice {
  jwk: EcPublicJwk;
  thumbprint: string;
  /** ECDSA P-256 / SHA-256 signature in IEEE P1363 form, base64url, as the PWA produces. */
  sign(bytes: Uint8Array): Promise<string>;
}

/** A planter device keypair, generated with WebCrypto like the PWA does. */
export async function newDevice(): Promise<TestDevice> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as EcPublicJwk;
  return {
    jwk,
    thumbprint: await jwkThumbprint(jwk),
    async sign(bytes) {
      const signature = await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        pair.privateKey,
        new Uint8Array(bytes),
      );
      return bytesToBase64Url(new Uint8Array(signature));
    },
  };
}
