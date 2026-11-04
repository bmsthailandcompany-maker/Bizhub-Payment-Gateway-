import { randomToken } from "../ids.ts";
import type { SlipCheck, SlipExpectation, SlipVerifier } from "./types.ts";

/**
 * Test-mode verifier: treats any image as a valid transfer of exactly the expected amount
 * to the expected receiver, so merchants can exercise the automatic flow without real money.
 */
export class MockSlipVerifier implements SlipVerifier {
  readonly name = "mock";

  async check(_image: Buffer, _mime: string, expected: SlipExpectation): Promise<SlipCheck> {
    return {
      kind: "slip",
      slip: {
        transRef: "TEST" + randomToken(16),
        amount: expected.amount,
        paidAt: new Date().toISOString(),
        receiver: { name: "TEST", account: expected.receiverAccount, proxy: expected.receiverProxy },
        sender: { name: "TEST CUSTOMER", bank: null },
        raw: { mock: true },
      },
    };
  }
}
