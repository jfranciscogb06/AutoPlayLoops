# LoopMail Website

Simple landing page for the Chrome extension.

## Local preview

Open `index.html` in a browser, or run a local server:

```bash
cd website
npx serve .
```

Then open http://localhost:3000

## Deploy

Static files only. Deploy the `website` folder to:
- **Vercel** — drag & drop or connect repo
- **Netlify** — same
- **GitHub Pages** — push to a `gh-pages` branch or use Actions

## Before publishing

Update the Chrome Web Store link in `index.html` — replace `https://chromewebstore.google.com/` with your extension's actual store URL once it's published.
