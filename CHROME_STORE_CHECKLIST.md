# Chrome Web Store — Submission Checklist

Use this guide to fix the "Unable to publish" requirements. Click **Save Draft** after each section.

---

## 1. Store listing tab

### Description* (min 25 characters)
Paste into the large text box:

```
LoopMail lets you preview audio loops directly in Gmail—no need to open each email. Built for music producers who receive loops via email. A playback bar appears below the Gmail search bar and plays 10-second previews of audio attachments (MP3, WAV, FLAC, etc.), then auto-advances. Features: search sync, shuffle, one-click download, keyboard shortcuts. Free for 1 week, then $4.99/month.
```

### Category*
Select: **Productivity**

### Language*
Select: **English** (or **English (United States)**)

### Store icon* (128×128)
Upload `icons/icon128.png` from your project. If missing, create a 128×128 PNG.

### Screenshots* (at least 1)
- Size: **1280×800** or **640×400**
- Format: JPEG or 24-bit PNG (no alpha)
- Take a screenshot of Gmail with the LoopMail bar visible and the panel open

### Homepage URL
```
https://autoplayloops.onrender.com
```

### Support URL
```
https://autoplayloops.onrender.com
```
(Or use a `mailto:1traptsoul@gmail.com` link if you prefer email-only support.)

---

## 2. Privacy practices tab

Go to **Privacy** in the left sidebar. Fill in:

### Single purpose description*
One sentence explaining the extension’s purpose:

```
LoopMail plays 10-second audio previews from your Gmail inbox so you can listen through loops efficiently without opening each email.
```

### Permission justifications

For each permission, add a short justification:

| Permission | Justification |
|------------|---------------|
| **downloads** | Lets users save audio loops they like directly to their computer. |
| **host permission** (mail.google.com, etc.) | Required to inject the playback bar into Gmail and fetch email metadata/attachments for audio preview. |
| **identity** | Used for Google sign-in to verify subscription status. |
| **offscreen** | Used for background audio playback so loops keep playing when the user switches tabs. |
| **remote code** | *(If shown — may not apply.)* We do not execute remote code. |
| **storage** | Stores OAuth tokens, subscription state, and user preferences (e.g. play duration) locally. |
| **tabs** | Used to detect the active Gmail tab and send playback state updates to the content script. |

### Data usage certification
Check the box certifying that your data usage complies with Developer Program Policies.

---

## 3. Account tab

1. Go to your **Developer account settings** (Account tab or dashboard gear icon).
2. Enter contact email: **1traptsoul@gmail.com**
3. Click **Verify** and complete the email verification.

---

## 4. Distribution tab

Ensure visibility is set (e.g. Public or Unlisted) as needed.

---

## Quick checklist

- [ ] Description filled (min 25 chars)
- [ ] Category: Productivity
- [ ] Language: English
- [ ] Store icon 128×128 uploaded
- [ ] At least 1 screenshot (1280×800 or 640×400)
- [ ] Homepage URL
- [ ] Support URL
- [ ] Privacy: Single purpose description
- [ ] Privacy: All permission justifications
- [ ] Privacy: Data usage certified
- [ ] Account: Contact email set
- [ ] Account: Contact email verified

---

## URLs to have live before submission

- **Homepage:** https://autoplayloops.onrender.com
- **Privacy:** https://autoplayloops.onrender.com/privacy.html

Deploy your site to Render so these URLs work. Update `privacy.html` contact email to `1traptsoul@gmail.com` if needed.
