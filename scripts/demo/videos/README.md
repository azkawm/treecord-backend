# Demo videos

Put sample evidence clips here (`.mp4`, `.mov` or `.webm`, 5 to 10 seconds, under 25 MB). The demo scripts upload them in name order through the real evidence pipeline, one per submission, cycling when they run out.

- With `MOCK_AI=true` (the default for the local demo) any file works, and the folder can stay empty: the scripts then generate small placeholder files.
- The API refuses a video hash it has seen before, so the scripts add 16 random bytes to each upload in a container element that players skip (an MP4 `free` box or a WebM Void element).
- The real AI service checks liveness, recapture and duplicate similarity. For a run against it, add one distinct clip of a real tree per submission (the full lifecycle makes 22).

Clips are not committed (see `.gitignore`), so large files never land in git.
