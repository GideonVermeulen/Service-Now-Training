# Writing a question bank

A bank is a single `.json` file. Upload it on the app's Library screen. It stays in your browser on your device and is never uploaded anywhere.

Start from `templates/bank-template.json`.

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
      "topic": "Optional, groups questions in Stats"
    }
  ]
}
```

## Fields

| Field | Required | Notes |
|---|---|---|
| `title` | no | If missing, the file name is used. Re-uploading a bank with the same title offers to update it and keep your progress. |
| `description` | no | Shown on the bank page. |
| `exam` | no | Defaults for exam mode. Any key can be left out. The defaults are 60 questions, 90 minutes and a 70% pass mark. You can change them before each exam. |
| `questions` | **yes** | At least one question. |
| `id` | recommended | A unique label per question, like `"q001"`. **Your progress is tied to the id.** With ids, you can fix typos and re-upload without losing progress. Without them, any change to a question's wording makes it count as a new question. |
| `question` | **yes** | The question text. |
| `options` | **yes** | 2 to 10 answer choices. They're shown as A, B, C… (the app shuffles their order each time you see them). |
| `answer` | **yes** | The correct option, or several for multi-answer questions. There are two ways to write it (see below). |
| `explanation` | no | Why the answer is right. |
| `topic` | no | Used for the per-topic breakdown in Stats. |
| `unverified` | no | `true` shows a note that the answer key isn't confirmed. |

## Writing answers

Either of these works:

- **Letters** (easiest): `"answer": "B"`, or for multi-answer, `"answer": ["A", "D"]`. The letters follow the order of your `options` list.
- **Numbers starting at 0**: `"answer": 1` means the **second** option. `"answer": [0, 3]` means the first and fourth.

A question with two or more answers is shown as "Choose 2", "Choose 3" and so on. You only get it right if you pick exactly the correct set.

## Older format

The app also accepts the earlier format, either a list of questions or an object with `questions`, using short keys:

```json
[{ "q": "Question text", "o": ["A", "B", "C", "D"], "a": [1], "u": false }]
```

## If the upload is rejected

The app lists what is wrong and where, for example "Question 14 (id q014): answer index 5 is out of range (4 options)". Fix those lines and upload again. Nothing is imported until the file is valid.

## Converting your notes with an AI

You can paste this guide plus your questions into an AI assistant and ask: "Convert these into a bank JSON file in this format, with ids q001, q002…, and letter answers." Check the answers before you rely on it.
