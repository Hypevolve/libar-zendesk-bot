# Support Bot Runbook

## Kad bot izgleda zaglavljeno

1. Provjeri zadnji internal note.
2. Provjeri `Final outcome`, `Source contract`, `Topic shift type` i `Knowledge quality`.
3. Ako je thread u `awaiting_human`, ne vraćati AI dok tim ne završi obradu.

## Kad treba isključiti AI na ticketu

1. Prebaci ticket u `human_active` ili `awaiting_human`.
2. Odgovori ručno iz Zendeska.
3. Potvrdi da web session pokazuje `Podrška uživo`.

## Kad treba resetirati conversation state

1. Provjeri je li ticket zapravo `resolved`, `human_active` ili `ai_active`.
2. Ukloni krive lifecycle tagove i postavi ispravan state kroz Zendesk state update.
3. Osvježi web session preko event webhooka.

## Triage reason kodovi

- `product_bleed`
- `support_shift_missed`
- `clarification_unnecessary`
- `knowledge_gap_real`
- `knowledge_gap_false_negative`
- `webhook_duplicate`
- `spam_false_positive`

## Kad prijaviti KB gap

Prijaviti ako:

- bot ispravno prepozna intent, ali nema dovoljno jak knowledge odgovor
- odgovor postoji na webu, ali ne postoji ili je zastario u KB-u
- postoje dva izvora s različitim informacijama

## Kad označiti false positive spam

Prijaviti ako:

- legitimni support mail bude blokiran
- poruka sadrži linkove ili duži quoted thread, ali je stvarni support upit
- outreach heuristika pogodi stvarni korisnički problem
