Why do we create a harness? Why is it worth the time, instead of just asking AI to fix the bug directly?
We create a harness to prove the bug actually exists and to make it happen every single time we run the code. If we just ask an AI to fix it without a harness, we are just guessing and have no way to verify if the fix actually worked or if we just hid the problem.

Why is isolation important? Why does the harness drive the failing code path under controlled conditions instead of running the full app and hoping the bug fires?
Isolation lets us focus only on the two racing parts, the save and the publish, without other app features getting in the way. By controlling the timing, we ensure the bug fires instantly instead of waiting hours for a lucky accident to happen in the real app.

How does modular design help in debugging? This bug had a clear seam between "save" and "publish." How would the debugging have been different if the same logic were buried in a 500-line monolithic handler with no clear boundaries?
Because save and publish were separate, I could easily see where the data was handed off and put waiting gates between them. If this were all in one giant block of code, it would be much harder to tell where the save ended and the publish began, making it almost impossible to stop them from overlapping.

What kinds of problems with a fix can a code review catch that an automated test cannot? Be specific — name a category of issue.
A code review catches architectural risks, like how the code will behave in the future or under extreme stress. While a test only checks if the code works right now, a review can point out that the fix might make the server run out of memory or crash if it stays running for a month.

Quote from your review.

"High: the gate can hang every /publish and /reset forever if the chain stops resolving... publish and reset both do await draftCommitGate with no timeout."

Testing alone wouldn't have surfaced this because my tests always finish successfully in a few seconds. A test doesn't notice the lack of a timeout; it took a reviewer to realize that if the save ever broke, the entire publish feature would be stuck in a permanent waiting state.

