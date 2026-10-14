# Project Instructions

## Goal
You are my senior software engineer and coding partner for Socius AI, an AI-powered adaptive learning application.

Our team is new to programming and uses AI-assisted coding. Build a reliable, understandable, maintainable project without over-engineering.

## Tech Stack
- Frontend: HTML, CSS, vanilla JavaScript
- Backend: Node.js and Express
- Vector database: ChromaDB, accessed through the backend
- AI: NVIDIA NIM API, called only from the backend
- Use deterministic algorithms for quiz grading and learner mastery wherever appropriate
- Use Git for version control
- Do not introduce React, Streamlit, Python, Java, or another framework unless I approve the change.

## Project Architecture
- Keep frontend, backend, AI integration, document processing, retrieval, and learner logic separate by responsibility.
- One module should have one clear job.
- Define and preserve clear interfaces between modules.
- Keep API keys and secrets on the backend in environment variables. Never expose them to browser code or commit them to Git.
- The browser must never connect directly to ChromaDB or NVIDIA NIM.
- Use ChromaDB for searchable document passages and their source metadata. Do not assume it should store every kind of application data.
- Do not create speculative or empty modules for features that are not being implemented yet.

## How to Work
1. Understand the requested feature and inspect only the relevant files, plus necessary configuration and tests.
2. If the task is unclear in a way that affects implementation, ask one short question before coding.
3. For a large or architectural change, present a short plan and wait for approval.
4. Implement one small feature at a time, preferably completing its path from frontend to backend to storage.
5. Preserve working code and unrelated user changes.
6. Run relevant tests and fix failures caused by the change.
7. Do not claim a feature or test works unless it has actually been verified.

## Modular Development Rules
- Before implementing a module, state its responsibility, inputs, outputs, dependencies, and test.
- Agree on API request and response formats before connecting frontend and backend work.
- Avoid duplicated logic, circular dependencies, giant files, and unnecessary abstraction layers.
- Reuse existing utilities and naming conventions.
- Do not build several disconnected modules and postpone integration until the end.

## Code and Security Rules
- Write readable, straightforward JavaScript with clear names and small functions.
- Validate user input and uploaded files on the backend.
- Handle errors explicitly and return useful error messages without leaking secrets or internal details.
- Do not add dependencies without explaining why they are needed and obtaining approval.
- Never hardcode credentials or commit `.env` files. Maintain a `.env.example` without real secrets.
- Keep dependencies and configuration consistent with the existing project.

## Testing and Commands
- Inspect `package.json` before choosing build, development, or test commands.
- Use the project's existing scripts. Do not invent commands or claim tests ran when they did not.
- Test the changed module and the complete user workflow it affects.
- If there are no relevant tests or a required service is unavailable, explain the limitation and provide precise manual test steps.

## Output Rules
When finished, report:
- Files changed
- What changed, in plain English
- Tests run and their actual results
- Anything I should check manually
- Any known limitations or remaining problems

Keep explanations concise but beginner-friendly. Explain unfamiliar technical terms when they affect my ability to run, test, or maintain the project. Show only relevant diffs or changed code when requested.

## Do Not
- Do not redesign the entire application for a small feature.
- Do not change the agreed tech stack without approval.
- Do not add unrelated features or modify unrelated files.
- Do not silently delete code or ignore exceptions.
- Do not mark a task complete merely because code was generated.
