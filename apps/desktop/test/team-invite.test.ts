import { describe, it, expect } from "vitest";
import { encodeInvite, decodeInvite, type TeamInvite } from "../src/main/team-invite.ts";

const sample: TeamInvite = {
  url: "wss://sync.example.com",
  token: "共享-token-1234567890",
  vaultId: "team-vault-uuid",
  ownerPubSign: Buffer.from(new Uint8Array(32).fill(7)).toString("base64"),
  enrollToken: "一次性邀請碼-abc",
  role: "editor",
};

describe("team invite bundle", () => {
  it("encode → decode 往返不失真", () => {
    expect(decodeInvite(encodeInvite(sample))).toEqual(sample);
  });

  it("容忍首尾空白(貼上常帶換行)", () => {
    expect(decodeInvite(`  ${encodeInvite(sample)}\n`)).toEqual(sample);
  });

  it("壞字串即拋", () => {
    expect(() => decodeInvite("!!!不是 base64!!!")).toThrow();
    expect(() => decodeInvite(Buffer.from("{}", "utf8").toString("base64url"))).toThrow(/欄位/);
    expect(() => decodeInvite(Buffer.from(JSON.stringify({ ...sample, token: "" }), "utf8").toString("base64url"))).toThrow(/token/);
  });

  it("role 缺失或非法收斂為 viewer(向前相容舊 bundle)", () => {
    const { role: _omit, ...noRole } = sample;
    void _omit;
    expect(decodeInvite(Buffer.from(JSON.stringify(noRole), "utf8").toString("base64url")).role).toBe("viewer");
    expect(decodeInvite(Buffer.from(JSON.stringify({ ...sample, role: "owner" }), "utf8").toString("base64url")).role).toBe("viewer");
    expect(decodeInvite(encodeInvite({ ...sample, role: "viewer" })).role).toBe("viewer");
  });
});
