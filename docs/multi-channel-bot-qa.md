# Multi-Channel Bot QA

Datum uskladjenja: 29.04.2026

## Automatizirani scope

Kljucevi testovi koji pokrivaju channel i policy regresije:
- `tests/botResponseRegression.test.js`
- `tests/channelIntegration.test.js`
- `tests/channelRegression.test.js`
- `tests/productIntentRegression.test.js`
- `tests/productRoutingRegression.test.js`
- `tests/zendeskWebhookRoute.test.js`

Pokretanje:

```bash
npm test
```

## Manual QA matrix

## Web chat

1. Otvori novi chat (`/chat`) i potvrdi da je obavezna samo poruka.
2. Pokreni chat bez imena i emaila, potvrdi da start radi.
3. Upisi email pogresnog formata, potvrdi validation error.
4. Posalji poruku s URL-om, potvrdi da je link klikabilan.
5. Posalji `zanima me samo jel se moze` bez konteksta i potvrdi clarifying odgovor (`followup_without_context`).
6. Posalji `Vanesa Vukas 091...` bez dodatnog konteksta i potvrdi `contact_details_without_intent` clarifying odgovor.
7. Posalji `Jako sam zadovoljna vasom uslugom` i potvrdi zahvalni odgovor (`positive_feedback_acknowledgement`).
8. Posalji `Mozete li spojiti dvije narudzbe u jedan paket?` i potvrdi `order_merge_guidance`.
9. Posalji `Kad mi dode kurir s narudzbom, mogu li mu predati knjige za otkup?` i potvrdi `buyback_delivery_exchange_guidance`.
10. Posalji poruku s privitkom i potvrdi handoff (`attachments_present`).

## Facebook webhook

1. Posalji buyback opening poruku i potvrdi buyback guidance.
2. Posalji support-info follow-up i potvrdi topic shift bez product bleeda.
3. Ponovi isti webhook audit payload i potvrdi da nema duplog odgovora (idempotency).

## Email webhook

1. Posalji support-info mail i potvrdi normalan odgovor.
2. Posalji order upit bez broja narudzbe i potvrdi `order_issue_clarification`.
3. Posalji spam-like outreach i potvrdi da nema customer AI odgovora.
4. Posalji quoted/forwarded email i potvrdi da je obradjena zadnja korisnicka poruka.

## Triage signali

Kod incidenta prvo provjeri:
- kanal
- final `outcome.type`
- `reason`
- `taskIntent`
- `conversationState`
- koristeni knowledge source (`zendesk_knowledge` / `onedrive_knowledge` / `website_links` / `policy_guard`)
