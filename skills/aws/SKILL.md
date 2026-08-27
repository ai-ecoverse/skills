---
name: aws
description: Query AWS from the command line with a working Signature Version 4 signer built for SLICC — `aws sts get-caller-identity` to check credentials and `aws ce get-cost-and-usage` for Cost Explorer, mirroring the real AWS CLI's command and flag names, plus a sibling binary `aws-ext cost` for analysis the upstream CLI has no command for: gross-vs-net discount breakouts (EDP, Private Rate Card), regime-break detection in a monthly series, per-service usage-quantity drilldown, and linked-account discovery. The reusable signer lives in `scripts/lib/sigv4.js` and is verified against AWS's official SigV4 test vectors — copy it into any skill that must sign an AWS request, because `crypto.createHmac` does not exist in this runtime. Use when the user mentions AWS cost, AWS bill or invoice, Cost Explorer, EDP or Enterprise Discount Program, AWS spend for a service, an AWS account id or ARN, STS session credentials, SigV4 or "signing an AWS request". Not Azure, not GCP (see the `gcloud` skill), not Fastly. Cost and credential focus — this is NOT a general EC2/S3/IAM management CLI.
allowed-tools: bash
command: aws
script: scripts/aws.jsh
---

# AWS (cost + SigV4)

Two binaries. **`aws`** mirrors the real AWS CLI — same command names, same flag
names (`aws sts get-caller-identity`, `aws ce get-cost-and-usage --granularity
MONTHLY`) — implemented directly against the AWS APIs, so copied docs and muscle
memory transfer. **`aws-ext`** holds what upstream does not have: cost analysis,
and an offline self-test for the signer.

There is no `aws` binary in SLICC and no SDK. The value here is
**`scripts/lib/sigv4.js`**: a Signature Version 4 signer that works in this
runtime, verified against AWS's own test vectors. Copy it into any skill that
needs to call an AWS API.

## Quick start

```bash
export AWS_ACCESS_KEY_ID=ASIA...          # env wins, exactly as in the real CLI
export AWS_SECRET_ACCESS_KEY=...
export AWS_SESSION_TOKEN=...              # required for federated/STS credentials

aws sts get-caller-identity               # which account am I actually in?
aws configure list                        # credential + region status (secrets masked)
aws-ext sigv4 verify                      # offline: prove the signer still works

aws-ext cost accounts                     # payer with children, or standalone?
aws-ext cost discounts                    # gross vs net — run this before quoting anything
aws-ext cost summary --months 12 --group-by SERVICE
aws-ext cost breaks --months 18           # step changes, per-regime means
aws-ext cost detail --service "Amazon Simple Storage Service"

aws ce get-cost-and-usage --start 2026-01-01 --end 2026-07-01 \
    --granularity MONTHLY --group-by RECORD_TYPE --json
```

Credentials: environment first, then `aws configure set aws_access_key_id …`
(stored via `skill.config()`). Secrets are never printed — `aws configure list`
shows the last four characters of the key id and nothing else, and `aws
configure get` is deliberately refused.

## Order of operations that avoids wrong answers

Four cost questions look like one question and are not. Ask them in this order:

1. **`aws-ext cost accounts` — whose money is this?** One linked account means a
   standalone account, and Cost Explorer in a member account cannot see its
   siblings. A credential that shows $400/mo may simply be in the wrong account.
2. **`aws-ext cost discounts` — gross or net?** An Enterprise Discount Program
   discount routinely removes 30–40% of the bill. One real account: $236,827
   gross usage, −$82,949 EDP (35%), −$8,496 Private Rate Card, **$145,380 net**.
   Quoting either number without saying which is a bigger error than most of the
   arguments these figures get used to settle.
3. **`aws-ext cost breaks` — is there one trend, or two regimes?** A real series
   ramped $10,275 → $15,365/mo through Jan 2026 and then halved to $6–9k after
   an optimisation. Full history says −9%/yr, the last six months say +53%/yr;
   both are artefacts of the window. Use the per-regime means.
4. **`aws-ext cost detail --service …` — what is the driver?** S3 in that same
   account was request-driven, not storage-driven: 142 billion Tier-2 requests
   ($35,373) against ~$147/mo of stored bytes. "Delete old objects" saves
   nothing there; batching and caching requests does.

## Traps this skill handles for you

- **Negative rows.** Discounts come back as negative `UnblendedCost`, and under
  `NoRegion` when you group by REGION. Averaging or percentaging across mixed
  signs produces shares like 162.6%; every command here computes shares against
  gross (positive) spend and lists negatives separately.
- **`End` is EXCLUSIVE.** To include June you ask for `--end 2026-07-01`.
- **The current month is `Estimated`.** It is a partial month, not a decline.
  Output marks it and trend maths excludes it.
- **The 14-month wall.** `ValidationException: You haven't enabled historical
  data beyond 14 months.` is caught, the window is clamped, and the clamp is
  reported — a silently shortened window would poison any growth rate.
- **Expiring credentials.** An Adobe `klam-master-role` session lasts ~4h; an
  expired token is reported as expired, with the fix, not as "access denied".

## Reference

- [`references/COMMANDS.md`](references/COMMANDS.md) — every command and flag.
- [`references/sigv4.md`](references/sigv4.md) — the signer: why WebCrypto and
  not `crypto.createHmac` (which does not exist here), the canonical-request
  rules, the test-vector results, and how to reuse it in another skill.
- [`references/cost-explorer-gotchas.md`](references/cost-explorer-gotchas.md) —
  the 14-month limit, exclusive `End`, the `Estimated` flag, negative/`NoRegion`
  discount rows, and what each `RECORD_TYPE` means.

## If signing breaks

Run `aws-ext sigv4 verify` **first**. It signs AWS's official test vectors
offline and compares the canonical request, string-to-sign and `Authorization`
header byte-for-byte, with no credentials and no network. If those pass, the
signer is fine and the problem is the credentials, the clock, or permissions
(Cost Explorer needs `ce:GetCostAndUsage`, granted in the **payer** account for
consolidated billing). If they fail, do not trust any figure the skill printed.
