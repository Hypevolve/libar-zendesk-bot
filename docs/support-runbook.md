# Support Bot Runbook

Datum uskladjenja: 29.04.2026

## Kad bot izgleda zaglavljeno

1. Provjeri zadnji internal note na ticketu.
2. Provjeri `Final outcome`, `reason`, `taskIntent` i `source`.
3. Ako je stanje `awaiting_human`, ne vracaj AI dok tim ne zavrsi obradu.

## Kad treba iskljuciti AI na ticketu

1. Odradi ljudski odgovor iz Zendeska.
2. Potvrdi da web session prikazuje `human-active` tone (`Podrska uzivo`).
3. Ne salji paralelni AI odgovor u istoj fazi.

## Kad treba resetirati conversation state

1. Provjeri ticket status (`new/open/pending/hold/solved/closed`).
2. Provjeri lifecycle tagove (`awaiting_human`, `awaiting_customer_detail`, `human_active`, `resolved`).
3. Triggeriraj `POST /webhook/zendesk/events` i potvrdi da session prima update.

## Najcesci reason kodovi

- `purchase_search_guidance`
- `online_buyback_guidance`
- `buyback_offer_guidance`
- `buyback_package_guidance`
- `buyback_delivery_exchange_guidance`
- `order_issue_clarification`
- `order_merge_guidance`
- `contact_details_without_intent`
- `followup_without_context`
- `positive_feedback_acknowledgement`
- `grounded_answer`
- `knowledge_fallback`
- `attachments_present`
- `no_answer_found`

## Runtime metrike

Provjeri na `/health`:
- `duplicate_chat_start_prevented_total`
- `webhook_duplicate_ignored_total`
- `clarification_asked_total`
- `knowledge_conflict_handoff_total`
- `outcome_*` brojac skupina

## Kad prijaviti KB gap

Prijavi KB gap ako:
- intent je prepoznat, ali nema dovoljno jak knowledge odgovor
- informacije na webu i KB-u nisu uskladjene
- bot cesto ide u `no_answer_found` za isti upitni pattern

## Kad oznaciti false positive spam

Prijavi ako:
- legitimni support email bude blokiran kao spam
- poruka sa quoted threadom bude odbijena iako sadrzi validan upit
