# Regression Report

Generated: 2026-04-20T18:04:19.289Z

## Knowledge Retrieval
- Total cases: 1000
- Passed: 1000
- Failed: 0
- Pass rate: 100%
- Duration: 21922 ms

Channel distribution:
- email: 250
- facebook: 250
- web_chat: 500

## Golden Answers
- Total cases: 150
- Passed: 108
- Failed: 42
- Pass rate: 72%
- Duration: 113 ms

Reason distribution:
- internal_process_leak: 25
- invalid_generated_reply: 21
- low_knowledge_overlap: 8
- ok: 88
- unsupported_fact_signal: 8

## Sample Failures
- Golden working-hours-invalid-dump: unexpected_pass_or_reason (invalid_generated_reply)
- Golden contact-invalid-dump: unexpected_pass_or_reason (low_knowledge_overlap)
- Golden r1-invalid-fact: unexpected_pass_or_reason (ok)
- Golden r1-invalid-dump: unexpected_pass_or_reason (low_knowledge_overlap)
- Golden installments-invalid-dump: unexpected_pass_or_reason (invalid_generated_reply)
- Golden return-invalid-dump: unexpected_pass_or_reason (invalid_generated_reply)
- Golden delivery-home-invalid-dump: unexpected_pass_or_reason (invalid_generated_reply)
- Golden delivery-locker-invalid-dump: unexpected_pass_or_reason (invalid_generated_reply)
- Golden delivery-times-invalid-fact: unexpected_pass_or_reason (ok)
- Golden delivery-times-invalid-dump: unexpected_pass_or_reason (invalid_generated_reply)