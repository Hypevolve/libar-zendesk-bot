# WordPress Embed

## Sažetak

Chatbot se može ugraditi na WordPress stranicu preko malog JavaScript snippeta koji učitava floating launcher i iframe widget s chatbot servera.

## Minimalni snippet

```html
<script>
  window.LibarChatConfig = {
    baseUrl: "https://your-chatbot-domain.example",
    position: "right"
  };
</script>
<script async src="https://your-chatbot-domain.example/embed.js"></script>
```

## Podržane opcije

`window.LibarChatConfig` podržava:

- `baseUrl` - obavezno, chatbot domena
- `position` - `right` ili `left`
- `offsetX` - horizontalni odmak u pikselima
- `offsetY` - vertikalni odmak u pikselima
- `zIndex` - opcionalni z-index launchera i panela
- `launcherLabel` - tekst za aria label i hover oznaku
- `theme` - opcionalni string za buduće proširenje

## WordPress ugradnja

Snippet se može dodati:

- u globalni footer / header code injection
- preko custom code plugina
- ili direktno kroz temu ako je to prihvatljiv način rada

## Napomena o sigurnosti

Ako se koristi `EMBED_ALLOWED_ORIGINS`, chatbot server treba imati dopuštenu WordPress domenu u `frame-ancestors` listi.
