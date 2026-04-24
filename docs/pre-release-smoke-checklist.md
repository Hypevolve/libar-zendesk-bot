# Pre-Release Smoke Checklist

## Web

1. Otvori novi widget razgovor i potvrdi da su kontakt podaci obavezni.
2. `Prodaja knjiga / otkup` -> `Želim prodati knjige` i potvrdi online-first korake s linkom na `/otkup-udzbenika/`.
3. U istom razgovoru pošalji `Koje vam je radno vrijeme?`.
4. U istom razgovoru pošalji `Imate li Algebra 1?` i potvrdi da nema product kartica nego link na `/kupi-udzbenike/`.
5. Pošalji `hvala, riješeno je` i potvrdi resolution prompt.
6. Potvrdi zatvaranje i provjeri da stari thread više ne prima AI odgovore.

## Facebook

1. Buyback opening.
2. Support-info follow-up.
3. Explicit product lookup.
4. Attachment/image escalation.
5. Ponovljeni webhook event ne smije dati dupli reply.

## E-mail

1. Support-info mail.
2. Buyback -> support-info follow-up.
3. Order status bez broja -> jedno kratko potpitanje.
4. Quoted reply chain.
5. Spam sample.

## Lifecycle

1. Human reply u Zendesk-u prebacuje thread u `human_active`.
2. Solved ticket prebacuje thread u `resolved`.
3. Reopen ili novo pitanje ne smije oživjeti stari resolved AI flow.

## Failure paths

1. Knowledge source failure završava na stabilnom handoffu.
2. Upload failure vraća korisniku jasan retryable error.
3. AI output failure ne ruši route i ne vraća 500 bez fallbacka.
