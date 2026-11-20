# ModelGo

Adds the two ModelGo sites to the DeepSeek Harness model picker.

## One step after installing: set your key

Scroll down this page: below this text are two cards, **ModelGo (modelgo.com)** and **ModelGo (modelgo.ai)**. Paste your key into the card of the site you use and click **Verify and save**.

The same fields are in **Settings → Models**; either place works.

Then go back to a conversation and click the model name at the bottom right of the composer: the ModelGo models are in the list. No restart is needed.

## Where the key comes from

| Site you use | Where to create a key | Card to paste it in |
|---|---|---|
| modelgo.com | The modelgo.com console | ModelGo (modelgo.com) |
| modelgo.ai | The modelgo.ai console | ModelGo (modelgo.ai) |

The two sites have separate accounts and keys. Set a key only for the site you use and leave the other empty; a site with no key shows no models.

A key starts with `mgk_`. It is checked against the site before it is saved, so a mistyped key, or a key from the other site, is refused on the spot.

## Common situations

| What you see | What to do |
|---|---|
| No ModelGo group in the model picker | No key is saved yet. Set it on this page or in Settings → Models |
| The site did not accept the key | Check the key has not been deleted and is in the card of the right site |
| A model is missing | The key has no permission for it in the ModelGo console, or it is not a chat model |
| You want to use another key | Paste the new key and save; it replaces the old one |

## Where the key is kept

Only in the local DSH credential store. It is never written to a config file and never shown again.

More options are on the [project page](https://github.com/modelgo/dsh-modelgo-provider#readme).
