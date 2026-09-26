export function randomId(cryptoImpl = globalThis.crypto) {
  if (typeof cryptoImpl?.randomUUID === "function") {
    try {
      return cryptoImpl.randomUUID();
    } catch {
      // Some browsers expose randomUUID on insecure LAN HTTP origins but reject the call.
      // getRandomValues remains available there and is sufficient to construct UUID v4.
    }
  }
  if (typeof cryptoImpl?.getRandomValues !== "function") {
    throw new Error("安全なIDを生成できません。このブラウザでは暗号学的乱数を利用できません。");
  }

  const bytes = cryptoImpl.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}
