# Regression Report

Generated: 2026-04-20T18:05:13.390Z

## Knowledge Retrieval
- Total cases: 1000
- Passed: 1000
- Failed: 0
- Pass rate: 100%
- Duration: 22934 ms

Channel distribution:
- email: 250
- facebook: 250
- web_chat: 500

## Golden Answers
- Total cases: 150
- Passed: 125
- Failed: 25
- Pass rate: 83.33%
- Duration: 134 ms

Reason distribution:
- internal_process_leak: 25
- invalid_generated_reply: 21
- low_knowledge_overlap: 4
- ok: 75
- unsupported_fact_signal: 25

## Sample Failures
- Golden working-hours-invalid-dump: unexpected_pass_or_reason (invalid_generated_reply)
- Golden contact-invalid-dump: unexpected_pass_or_reason (low_knowledge_overlap)
- Golden r1-invalid-dump: unexpected_pass_or_reason (low_knowledge_overlap)
- Golden installments-invalid-dump: unexpected_pass_or_reason (invalid_generated_reply)
- Golden return-invalid-dump: unexpected_pass_or_reason (invalid_generated_reply)
- Golden delivery-home-invalid-dump: unexpected_pass_or_reason (invalid_generated_reply)
- Golden delivery-locker-invalid-dump: unexpected_pass_or_reason (invalid_generated_reply)
- Golden delivery-times-invalid-dump: unexpected_pass_or_reason (invalid_generated_reply)
- Golden tracking-invalid-dump: unexpected_pass_or_reason (invalid_generated_reply)
- Golden basic-school-invalid-dump: unexpected_pass_or_reason (invalid_generated_reply)