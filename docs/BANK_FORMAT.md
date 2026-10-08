# Writing a question bank

A bank is a single `.json` file. Upload it on the app's Library screen. It stays in your browser on your device and is never uploaded anywhere.

Start from `templates/bank-template.json`.

Use questions you wrote yourself or are licensed to use. Don't upload real exam content (so-called exam dumps): certification agreements, including ServiceNow's, forbid sharing it.

## Structure

```json
{
  "title": "My exam bank",
  "description": "Optional",
  "exam": { "questionCount": 60, "timeLimitMinutes": 90, "passMarkPercent": 70 },
  "questions": [
    {
      "id": "q001",
      "question": "Which option is correct?",
      "options": ["Option A", "Option B", "Option C", "Option D"],
      "answer": "B",
      "explanation": "Optional, shown after answering",
      "topic": "Optional, e.g. the exam domain"
    }
  ]
}
```

## Fields

| Field | Required | Notes |
|---|---|---|
| `title` | no | If missing, the file name is used. Re-uploading a bank with the same title offers to update it. See [Updating a bank](#updating-a-bank). |
| `description` | no | Shown on the bank page. |
| `exam` | no | Defaults for exam mode. Any key can be left out. The defaults are 60 questions, 90 minutes and a 70% pass mark. `timeLimitMinutes: 0` means untimed, and `questionCount` is capped at the number of questions in the bank. You can change them before each exam. The pass mark is your assumption: real exams may use a different cut score (ServiceNow's isn't published and isn't always 70%). Chance of passing uses these defaults. |
| `exam.topicWeights` | no | The real exam's blueprint, as a percentage per topic. See [Topic weights](#topic-weights). |
| `questions` | **yes** | At least one question. |
| `id` | recommended | A unique label per question, like `"q001"`. **Your progress is tied to the id.** With ids, you can fix typos and re-upload without losing progress. Without them, any change to a question's wording makes it count as a new question. |
| `question` | **yes** | The question text. |
| `options` | **yes** | 2 to 10 answer choices, shown as A, B, C… With *Shuffle answer options* on (the default), practice reshuffles them every time and each mock exam shuffles them once. |
| `answer` | **yes** | The correct option, or several for multi-answer questions. There are two ways to write it (see below). |
| `explanation` | no | Why the answer is right. |
| `topic` | no | Groups questions. Used for readiness by topic on the bank page, score by topic after a mock exam, the topic filter in Practice, the breakdown in Stats, and how mock exams spread questions across topics. For certification exams, use the official exam domain names (as on the exam guide or score report) so you can compare like with like. |
| `unverified` | no | `true` shows a note that the answer key isn't confirmed. Once you've checked it, choose *mark as verified* on the note to clear it. |

## Writing answers

Either of these works:

- **Letters** (easiest): `"answer": "B"`, or for multi-answer, `"answer": ["A", "D"]`. The letters follow the order of your `options` list.
- **Numbers starting at 0**: `"answer": 1` means the **second** option. `"answer": [0, 3]` means the first and fourth.

A question with two or more answers is shown as "Choose 2", "Choose 3" and so on. You only get it right if you pick exactly the correct set.

## Topic weights

Mock exams draw questions per topic, so each topic gets a fair share of the exam. By default the share is how many questions the bank has for that topic. If the real exam's blueprint differs (for example, it is 18% access control but your bank only has a few of those questions), set `exam.topicWeights`:

```json
"exam": {
  "questionCount": 60,
  "topicWeights": { "Access Control & Security": 18, "Incident/Problem/Change (ITSM)": 12, "Mobile": 5 }
}
```

- Keys must match question `topic` values exactly. Questions without a topic belong to `"Unlabeled"`.
- Values are percentages from 0 to 100. If they don't add up to 100, the app warns and scales them to 100.
- Topics left out of `topicWeights` (or set to 0) are only used to fill up an exam when the weighted topics don't have enough questions. The same applies when a weighted topic runs short: its shortfall is shared among the other weighted topics first.
- A key that doesn't match any question's topic is a warning, not an error.
- A bank without `topicWeights` imports normally, with a warning saying what mock exams will do instead (follow the bank's own topic mix, or draw at random if there are no topics).

## Older format

The app also accepts the earlier format, either a list of questions or an object with `questions`, using short keys:

```json
[{ "q": "Question text", "o": ["A", "B", "C", "D"], "a": [1], "u": false }]
```

## Updating a bank

Upload the changed file with *Update questions* on the Library screen (or upload a file with the same title). Progress is matched by `id`:

- Questions with the same id keep your progress, unless their right answer is now different text. Reordering options, adding a wrong option or fixing a typo doesn't count as a change.
- New ids start as New; ids that are gone are removed with their progress.

You can also add, edit and delete questions in the app (Stats → *+ Add question*, or *Edit question* on any question). Those changes live in your browser only. Use *Download bank* on the bank page to save them as a file. If you upload a file over a bank you changed in the app, you're asked first, with an option to download a copy.

## If the upload is rejected

The app lists what is wrong and where, for example "Question 14 (id q014): answer index 5 is out of range (4 options)". Fix those lines and upload again. Nothing is imported until the file is valid.

Smaller problems are warnings: the bank still imports, and the summary lists them. Examples: unknown fields (ignored), duplicate question or option text, topic weights that don't add up to 100, or no topic weights at all.

## Converting your notes with an AI

You can paste this guide plus your questions into an AI assistant and ask: "Convert these into a bank JSON file in this format, with ids q001, q002…, letter answers, a topic for each question using these domain names: …, and a short explanation for each answer." Check the answers before you rely on it, and set `"unverified": true` on any you aren't sure of.
