# ServiceNow Exam Training

A static study app for memorising multiple-choice exam banks. Upload a bank as JSON, practise it, and the app shows your weak questions more often until you've mastered them. Exam mode runs a timed mock test.

Everything runs in your browser. Banks and progress are stored in `localStorage` on your device and are never sent anywhere.

## Run locally

Double-click `index.html`. It works from `file://` in current Chrome, Edge and Firefox. You don't need a server, a build step or an internet connection.

To try it out, start from `templates/bank-template.json` (see the format guide below) and upload it on the Library screen. No question banks are included in the repository: use your own or properly licensed questions.

## Deploy to GitHub Pages

1. Push this folder to a GitHub repository.
2. Go to **Settings → Pages**, choose **Deploy from a branch**, then pick the branch and `/ (root)`.
3. Open the URL GitHub gives you. Each visitor's data stays in their own browser.

## Writing banks

See [`docs/BANK_FORMAT.md`](docs/BANK_FORMAT.md) and start from [`templates/bank-template.json`](templates/bank-template.json).

## Tests

Open `tests/tests.html` from disk. Every line should read PASS. To run them headlessly, as CI does on every push and pull request: `npm ci`, `npx playwright install chromium`, then `npm test`. Set `PW_CHANNEL=msedge` or `chrome` to use an installed browser instead of downloading Chromium. The `package.json` exists only for this; the app has no build step. The tests use their own storage prefix (`set-test:v1:`), so they don't touch your real data.

If you keep a bank at `banks/tprm.json` (not in the repository; both files are git-ignored), a few extra tests check it through `tests/tprm-data.js`, a copy made because local files can't be fetched over `file://`. Without the copy those tests are skipped. To regenerate it:

```
node -e "const fs=require('fs');fs.writeFileSync('tests/tprm-data.js','window.TPRM_BANK = '+JSON.stringify(JSON.parse(fs.readFileSync('banks/tprm.json','utf8')))+';\n')"
```

## Implementation notes

These cover choices the spec leaves open (SPEC preamble):

- **Default theme is System**, which follows your device. You can switch to Light or Dark in Settings or with the header toggle. Dark mode uses slate surfaces with the spec's teal accent (`#2DD4BF`). It deliberately uses no company colours.
- **Scheduling uses FSRS-5** (`js/fsrs.js`) with its published default weights and 90% target retention. In practice, after a right first-attempt answer you rate it Hard, Good or Easy; a wrong answer counts as Again. Exam answers count as Good or Again, with no rating step. A question is **Mastered** once its FSRS stability reaches 21 days (`MASTERY_DAYS` in `js/weighting.js`), and **Weak** when its last answer was wrong.
- **Same-day repeats.** Only the first right answer to a question each day (local time) counts towards its memory strength, as in FSRS-4.5. Later right answers that day still count for accuracy and streak, and a wrong answer always counts. So Mastered can only be earned across days, however long you study in one sitting.
- **Exam date.** A bank's page asks for the exam date once (you can choose "No date yet" and set it later). With a date set, no review is scheduled after it.
- **Study plan.** The bank page shows how many questions are due for review today, and a readiness estimate: the predicted mock-exam score, weighted by topic like the exam. Each question counts as the average of its FSRS recall chance (topped up by the chance of guessing the part you'd have forgotten) and your smoothed accuracy on it. Accuracy here (and in Weakest 10) uses only your first answer to a question each day, so repeating it the same day can't inflate the estimate; the Accuracy column in Stats still counts every attempt. Unseen questions count as guesses. It's a guide, not a promise. It is calibrated against your own mock exams: each exam records the estimate for its exact questions when it starts, and readiness is shifted by the average gap between actual and estimated scores over your last 5 mock exams (divided by the number of exams + 2, so one exam only moves it a third of the way; capped at ±20 points; exams less than 80% answered are ignored).
- **Chance of passing** is the probability of reaching the pass mark on a mock exam of the bank's default size from this question set: Φ((readiness − pass threshold) ÷ spread), where the spread combines luck of the draw (√(p(1−p)/n)) with the estimate's own error (the spread of actual − predicted over recent mock exams; ±8 points until 3 exist, never below ±3). Shown as Likely (80%+), Borderline (50–79%) or Unlikely. It appears once you've seen at least 30% of the questions or taken a mock exam; before that, unseen questions (counted as guesses) would dominate it. It is for this question set only and is not a guarantee for the real exam; the bank page says so next to it.
- **Focus options.** *Not mastered* (formerly *Weak only*) leaves out Mastered questions. *Due first* serves questions that are due or were answered wrong, then new ones, then the rest.
- **Unverified answers.** Wherever an unverified note appears (practice feedback, exam and practice reviews, Stats), *I've checked it — mark as verified* clears the flag on the spot. Progress is kept, and it counts as an in-app change, so re-uploading the file warns first. To flag a question again, use the editor.
- **Editing questions.** Use *+ Add question* or *Edit question* (expand a row) in Stats, or *Spotted a mistake?* after answering in practice. The editor can also delete a question, along with your progress on it; a bank always keeps at least one question. New questions get the next id in the bank's pattern (for example `tprm-181`). Changing which answer is correct resets your progress on that question; fixing wording doesn't. Edits live in this browser, so use *Download bank* on the bank page to save the updated JSON. Otherwise uploading your original file again brings the old version back.
- **Older progress** (from before FSRS) is converted the first time each question is read, so nothing is lost. The conversion is a rough estimate, so questions that used to show as Mastered may show as Learning until you've reviewed them once or twice.
- **Status colours.** New is grey, Weak is red, Learning is blue and Mastered is green. Every status also has a text label. Amber is reserved for flags and timer warnings.
- **Importing a bank with a new title** happens straight away and then shows a summary. Only a title clash asks you to choose.
- **Fallback ids.** The FNV-1a hash runs over the UTF-8 bytes of the normalised text. If two questions without ids have identical text, the second one gets `-2`, the third `-3`, and so on, so the import isn't blocked by a duplicate id error. Duplicate text is still reported as a warning.
- **Invalid `exam` values** are a warning, and the default is used instead. Bad `description` is ignored with a warning. Wrong types on question fields (`explanation`, `topic`, `unverified`) are errors.
- **Index entries** also store `lastStudied`, which is shown on bank cards. `updatedAt` is bumped whenever a bank's questions, progress or sessions change. A backup *Merge* therefore keeps whichever copy you studied most recently. That copy's questions, progress and sessions are kept together.
- **Untrusted files.** Banks and backups are treated as untrusted. Text is always inserted as plain text, never HTML. Topic names and ids that clash with built-in JavaScript names (`__proto__`, `constructor`, `toString`…) are refused, and internal lookup tables have no built-in names anyway. Every bank in a backup goes through the same checks as an upload: damaged ones are skipped and named, and *Replace everything* checks the whole backup before deleting anything. If stored data is damaged anyway, the page shows a recovery screen (with *Delete this bank*) instead of going blank.
- **Backup Merge** keeps your current settings. *Replace everything* restores the settings from the backup. Unfinished sessions are not included in backups.
- **Exam option order** is shuffled once per exam and stays the same while you move between questions. Practice reshuffles every time a question is shown.
- **Exam progress.** Only questions you answered update progress. Unanswered questions still count as wrong in the score.
- **Exam summaries** also store `passMarkPercent`, which the stats chart uses for its pass-mark line.
- **"Overall progress"** on the practice results counts questions whose last counted answer was correct (Learning + Mastered). **"This test: x / n"** counts the test's questions solved in any round.
- **New test** from practice results reuses the same size and focus.
- **The exam timer** only runs while the exam screen is open. If the deadline passes while you're elsewhere, the exam is submitted as soon as you return to it. This is the same behaviour as resuming after closing the tab.
- **End test** asks for confirmation before ending.
