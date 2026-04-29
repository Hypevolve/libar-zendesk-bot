# Pre-Release Smoke Checklist

Datum uskladjenja: 29.04.2026

## Web

1. Pokreni novi chat i potvrdi da je obavezna samo poruka.
2. Potvrdi da su `name` i `email` opcionalni na startu.
3. Upisi neispravan email i potvrdi da backend vraca 400.
4. Posalji poruku s URL-om i potvrdi klikabilan link u bubbleu.
5. `zanima me samo jel se moze` bez konteksta -> clarifying (`followup_without_context`).
6. `Jako sam zadovoljna vasom uslugom` -> positive feedback ack.
7. `Mozete li spojiti dvije narudzbe u jedan paket?` -> `order_merge_guidance`.
8. `Kad mi dode kurir s narudzbom, mogu li mu predati knjige za otkup?` -> `buyback_delivery_exchange_guidance`.
9. Posalji privitak -> `attachments_present` handoff.

## Facebook

1. Buyback opening poruka.
2. Support-info follow-up u istoj niti.
3. Ponovljeni webhook event ne smije dati dupli reply.

## Email

1. Support-info mail.
2. Order status bez broja narudzbe -> clarifying.
3. Spam sample -> bez customer AI odgovora.
4. Quoted mail chain -> ispravno parsiran latest user message.

## Lifecycle

1. Human reply u Zendesku mora prebaciti web stanje u `human-active`.
2. Solved ticket mora prebaciti web stanje u `resolved`.
3. Closed session restore mora vratiti mode `closed_session`.

## Failure paths

1. Zendesk dependency fail na restoreu vraca `degraded` kad postoji lokalna session kopija.
2. Upload failure vraca jasan retryable error.
3. Niski knowledge confidence ne smije zavrsiti halucinacijom, vec policy fallbackom ili handoffom.
