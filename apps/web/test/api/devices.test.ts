import { jwkThumbprint } from "@treecord/shared";
import { describe, expect, it } from "vitest";
import { POST as registerDevice } from "@/app/api/devices/route";
import { DELETE as revokeDevice } from "@/app/api/devices/[id]/route";
import { call, createUser, dbAvailable, field, newDeviceJwk } from "../helpers";

describe.skipIf(!dbAvailable)("devices", () => {
  it("registers a device and returns its RFC 7638 thumbprint", async () => {
    const planter = await createUser("planter");
    const jwk = await newDeviceJwk();
    const res = await call(registerDevice, {
      token: planter.token,
      body: { publicKeyJwk: jwk, label: "Pixel 8" },
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      device: { thumbprint: await jwkThumbprint(jwk), label: "Pixel 8" },
    });
  });

  it("only lets planters register devices", async () => {
    const donor = await createUser("donor");
    const res = await call(registerDevice, {
      token: donor.token,
      body: { publicKeyJwk: await newDeviceJwk() },
    });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: { code: "forbidden_role" } });
  });

  it("rejects invalid keys and private keys", async () => {
    const planter = await createUser("planter");
    const jwk = await newDeviceJwk();
    const wrongCurve = await call(registerDevice, {
      token: planter.token,
      body: { publicKeyJwk: { ...jwk, crv: "P-384" } },
    });
    expect(wrongCurve.status).toBe(400);
    const withPrivate = await call(registerDevice, {
      token: planter.token,
      body: { publicKeyJwk: { ...jwk, d: jwk.x } },
    });
    expect(withPrivate.status).toBe(400);
    expect(withPrivate.body).toMatchObject({ error: { code: "validation_error" } });
  });

  it("allows at most 3 active devices, and revoking frees a slot", async () => {
    const planter = await createUser("planter");
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await call(registerDevice, {
        token: planter.token,
        body: { publicKeyJwk: await newDeviceJwk() },
      });
      expect(res.status).toBe(201);
      ids.push(field<string>(res.body, "device.id"));
    }
    const fourth = await call(registerDevice, {
      token: planter.token,
      body: { publicKeyJwk: await newDeviceJwk() },
    });
    expect(fourth.status).toBe(409);
    expect(fourth.body).toMatchObject({ error: { code: "device_limit_reached" } });

    const revoked = await call(revokeDevice, {
      method: "DELETE",
      token: planter.token,
      params: { id: ids.at(0) ?? "" },
    });
    expect(revoked.status).toBe(200);
    expect(field(revoked.body, "device.revokedAt")).toBeTruthy();

    const replacement = await call(registerDevice, {
      token: planter.token,
      body: { publicKeyJwk: await newDeviceJwk() },
    });
    expect(replacement.status).toBe(201);
  });

  it("rejects registering the same key twice", async () => {
    const planter = await createUser("planter");
    const jwk = await newDeviceJwk();
    await call(registerDevice, { token: planter.token, body: { publicKeyJwk: jwk } });
    const again = await call(registerDevice, { token: planter.token, body: { publicKeyJwk: jwk } });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: { code: "device_already_registered" } });
  });

  it("revoking is idempotent and limited to the owner", async () => {
    const owner = await createUser("planter");
    const other = await createUser("planter");
    const res = await call(registerDevice, {
      token: owner.token,
      body: { publicKeyJwk: await newDeviceJwk() },
    });
    const id = field<string>(res.body, "device.id");

    const stranger = await call(revokeDevice, {
      method: "DELETE",
      token: other.token,
      params: { id },
    });
    expect(stranger.status).toBe(404);

    const first = await call(revokeDevice, {
      method: "DELETE",
      token: owner.token,
      params: { id },
    });
    const second = await call(revokeDevice, {
      method: "DELETE",
      token: owner.token,
      params: { id },
    });
    expect(second.status).toBe(200);
    expect(field(second.body, "device.revokedAt")).toBe(field(first.body, "device.revokedAt"));

    const badId = await call(revokeDevice, {
      method: "DELETE",
      token: owner.token,
      params: { id: "nope" },
    });
    expect(badId.status).toBe(400);
  });
});
