# ServiceNow Exam Training

A static study app for memorising multiple-choice exam banks. Upload a bank as JSON, practise it, and the app shows your weak questions more often until you've mastered them. Exam mode runs a timed mock test.

Everything runs in your browser. Banks and progress are stored in `localStorage` on your device and are never sent anywhere.

## Run locally

Double-click `index.html`. It works from `file://` in current Chrome, Edge and Firefox. You don't need a server, a build step or an internet connection.

To try it out, upload `banks/tprm.json` on the Library screen.

## Deploy to GitHub Pages

1. Push this folder to a GitHub repository.
2. Go to **Settings → Pages**, choose **Deploy from a branch**, then pick the branch and `/ (root)`.
3. Open the URL GitHub gives you. Each visitor's data stays in their own browser.

## Writing banks

See [`docs/BANK_FORMAT.md`](docs/BANK_FORMAT.md) and start from [`templates/bank-template.json`](templates/bank-template.json).

## Tests

Open `tests/tests.html` from disk. Every line should read PASS. The tests use their own storage prefix (`set-test:v1:`), so they don't touch your real data.

`tests/tprm-data.js` is a copy of `banks/tprm.json`, because local files can't be fetched over `file://`. If you change the bank, regenerate the copy:

```
node -e "const fs=require('fs');fs.writeFileSync('tests/tprm-data.js','window.TPRM_BANK = '+JSON.stringify(JSON.parse(fs.readFileSync('banks/tprm.json','utf8')))+';\n')"
```

## Implementation notes

These cover choices the spec leaves open (SPEC preamble):

- **Default theme is Dark.** You can switch to System or Light in Settings or with the header toggle. Dark mode uses slate surfaces with the spec's teal accent (`#2DD4BF`). It deliberately uses no company colours.
- **Status colours.** New is grey, Weak is red, Learning is blue and Mastered is green. Every status also has a text label. Amber is reserved for flags and timer warnings.
- **Importing a bank with a new title** happens straight away and then shows a summary. Only a title clash asks you to choose.
- **Fallback ids.** The FNV-1a hash runs over the UTF-8 bytes of the normalised text. If two questions without ids have identical text, the second one gets `-2`, the third `-3`, and so on, so the import isn't blocked by a duplicate id error. Duplicate text is still reported as a warning.
- **Invalid `exam` values** are a warning, and the default is used instead. Bad `description` is ignored with a warning. Wrong types on question fields (`explanation`, `topic`, `unverified`) are errors.
- **Index entries** also store `lastStudied`, which is shown on bank cards. `updatedAt` is bumped whenever a bank's questions, progress or sessions change. A backup *Merge* therefore keeps whichever copy you studied most recently. That copy's questions, progress and sessions are kept together.
- **Backup Merge** keeps your current settings. *Replace everything* restores the settings from the backup. Unfinished sessions are not included in backups.
- **Exam option order** is shuffled once per exam and stays the same while you move between questions. Practice reshuffles every time a question is shown.
- **Exam progress.** Only questions you answered update progress. Unanswered questions still count as wrong in the score.
- **Exam summaries** also store `passMarkPercent`, which the stats chart uses for its pass-mark line.
- **"Overall progress"** on the practice results counts questions whose last counted answer was correct (Learning + Mastered). **"This test: x / n"** counts the test's questions solved in any round.
- **New test** from practice results reuses the same size and focus.
- **The exam timer** only runs while the exam screen is open. If the deadline passes while you're elsewhere, the exam is submitted as soon as you return to it. This is the same behaviour as resuming after closing the tab.
- **End test** asks for confirmation before ending.
