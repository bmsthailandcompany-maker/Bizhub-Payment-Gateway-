/**
 * PromptPay QR payload builder (EMVCo Merchant-Presented QR, Thai QR Payment standard).
 *
 * Supported PromptPay IDs:
 *   - mobile number (10 digits, e.g. 0812345678)
 *   - national ID / tax ID (13 digits)
 *   - e-wallet ID (15 digits)
 */

const PROMPTPAY_AID = "A000000677010111";

function tlv(tag: string, value: string): string {
  return tag + value.length.toString().padStart(2, "0") + value;
}

/** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF), as required by EMVCo QR. */
export function crc16(data: string): string {
  let crc = 0xffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

export function normalizePromptPayId(raw: string): { subTag: string; value: string } {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10 && digits.startsWith("0")) {
    // Mobile: 0066 + number without the leading 0, left-padded to 13 digits.
    return { subTag: "01", value: ("66" + digits.slice(1)).padStart(13, "0") };
  }
  if (digits.length === 13) return { subTag: "02", value: digits };
  if (digits.length === 15) return { subTag: "03", value: digits };
  throw new Error("Invalid PromptPay ID: expected a 10-digit mobile, 13-digit ID or 15-digit e-wallet");
}

export function isValidPromptPayId(raw: string): boolean {
  try {
    normalizePromptPayId(raw);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param promptpayId recipient PromptPay ID
 * @param amountSatang amount in satang (1 THB = 100 satang); omit for an open-amount QR
 */
export function buildPromptPayPayload(promptpayId: string, amountSatang?: number): string {
  const { subTag, value } = normalizePromptPayId(promptpayId);
  const hasAmount = amountSatang !== undefined && amountSatang > 0;
  let payload =
    tlv("00", "01") +
    tlv("01", hasAmount ? "12" : "11") +
    tlv("29", tlv("00", PROMPTPAY_AID) + tlv(subTag, value)) +
    tlv("58", "TH") +
    tlv("53", "764") +
    (hasAmount ? tlv("54", (amountSatang / 100).toFixed(2)) : "");
  payload += "6304";
  return payload + crc16(payload);
}

const BILL_PAYMENT_AID = "A000000677010112";

/** Biller IDs are 15 digits: the 13-digit tax ID plus a 2-digit suffix assigned by the bank. */
export function isValidBillerId(raw: string): boolean {
  return /^\d{15}$/.test(raw.replace(/\D/g, ""));
}

/**
 * Thai QR "bill payment" payload (tag 30). The bank that issued the Biller ID reports every
 * payment back with Reference 1, so the gateway can match it to the exact payment.
 * @param ref1 up to 20 upper-case letters/digits identifying the payment
 */
export function buildBillPaymentPayload(billerId: string, ref1: string, amountSatang: number, ref2?: string): string {
  const biller = billerId.replace(/\D/g, "");
  if (biller.length !== 15) throw new Error("Biller ID must be 15 digits");
  if (!/^[A-Z0-9]{1,20}$/.test(ref1)) throw new Error("Reference 1 must be 1-20 upper-case letters or digits");
  if (ref2 !== undefined && !/^[A-Z0-9]{1,20}$/.test(ref2)) throw new Error("Reference 2 must be 1-20 upper-case letters or digits");
  let payload =
    tlv("00", "01") +
    tlv("01", "12") +
    tlv("30", tlv("00", BILL_PAYMENT_AID) + tlv("01", biller) + tlv("02", ref1) + (ref2 ? tlv("03", ref2) : "")) +
    tlv("58", "TH") +
    tlv("53", "764") +
    tlv("54", (amountSatang / 100).toFixed(2));
  payload += "6304";
  return payload + crc16(payload);
}
