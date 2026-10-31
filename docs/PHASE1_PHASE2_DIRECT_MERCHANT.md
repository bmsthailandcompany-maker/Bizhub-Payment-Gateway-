# BIZHUB PAY — Phase 1 & 2 implementation

## Phase 1: merchant self-onboarding
- Existing `GET /signup` and `POST /signup/api` create a merchant owner and a **test-mode** session immediately.
- Enable with `SIGNUP_ENABLED=true` after production abuse/rate-limit/terms review. Do not bypass KYC for live processing.
- Owners can manage business settings and submit KYC documents through the existing merchant dashboard.
- A business can sign up even if it is newly formed; eligibility to receive live payments depends on the provider and compliance review.

## Phase 2: direct-to-merchant payments
- Settlement destination: **merchant's own bank account**; BIZHUB PAY does not custody merchant proceeds.
- `GET /dashboard/api/payment-integration` reports KYC and existing test/live bank connector configuration.
- Existing `/dashboard/api/bank` and bank notification endpoints support HMAC-authenticated incoming events and matching to pending payments. A configured webhook URL **does not** mean the bank/provider is connected.
- Payment-provider activation requires a commercial account, merchant authorization, callback credentials, provider-specific payload mapping and signed event verification.
- Never mark a payment paid based solely on a generated QR or client confirmation. Reject duplicate or ambiguous matches and send to review.
- Before enabling live: provider sandbox end-to-end test, replay protection, exact amount/reference matching, refund and reconciliation policies, operational monitoring.

## External dependencies still required
1. Select and contract a licensed bank or PSP with direct merchant settlement and multi-merchant onboarding.
2. Obtain sandbox credentials and documented signed callback format.
3. Implement provider-specific adapter mapping callbacks into the bank event contract.
4. Complete certification and live merchant onboarding with provider approval.

**Not implemented:** Direct live bank/PSP credentials or production callback adapter, because no provider account or technical contract has been supplied.
