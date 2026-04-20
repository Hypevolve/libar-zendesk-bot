# Knowledge Source of Truth

## Kanonski izvori

- `support_info`: Zendesk Help Center
- `delivery_support`: Zendesk Help Center
- `order_support` / opći order FAQ: Zendesk Help Center
- `buyback` procedural i procjena: OneDrive
- `product_lookup`: product feed only

## Pravila prioriteta

1. Ako je domain `product_lookup`, ne koristiti Zendesk/OneDrive kao primarni odgovor za dostupnost ili cijenu.
2. Ako je domain `buyback`, OneDrive je prvi izvor; Zendesk može biti pomoćni.
3. Ako je domain `support_info`, `delivery_support` ili opći `order_support`, Zendesk je prvi izvor.
4. Ako Zendesk i OneDrive daju konfliktan odgovor za support temu, Zendesk ima prednost osim za `buyback`.

## KB audit checklist

Za svaki topic provjeriti:

- postoji li barem jedan jasan članak ili dokument
- odgovara li članak izravno na tipično korisničko pitanje
- je li sadržaj aktualan i usklađen s web stranicom
- postoji li kontradikcija između Zendesk, OneDrive i weba
- treba li topic dodatni redirect ili canonical source override

## Obavezni audit topicovi

- radno vrijeme
- adresa i kontakt
- dostava
- status narudžbe i opći order FAQ
- buyback / otkup
- reklamacije i povrati
- plaćanje
- osobno preuzimanje
- stanje knjiga i dostupnost
