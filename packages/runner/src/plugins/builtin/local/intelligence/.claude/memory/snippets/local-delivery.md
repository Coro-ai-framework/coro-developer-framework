# Local repository — how work is delivered

The local SCM plugin (`pluginId: local`) has no hosting service behind it. The
"repository" is a git checkout on the user's own machine, and **the branch is
the deliverable**.

## Repo identity

`repo` is an absolute filesystem path, not an `owner/repo` slug:

```
/Users/someone/code/my-service
```

`scm_get_clone_info` returns that path as the clone URL, so `scm_clone_repo`
produces a normal clone whose `origin` is the user's repository.

## Opening a pull request

`scm_create_pr` does two things:

1. Pushes your branch from the job checkout into the user's repository.
2. Records an open pull request in a local JSON store so status, comments,
   and approval have somewhere to live.

The push is the part that matters. If it fails, the work never reached the
user — treat the error as fatal for the phase rather than continuing.

Push only the branch you created (`coro/...`). Git refuses a push to the
branch the target repository currently has checked out, and that refusal is
correct: it would corrupt someone's working tree.

## Reviews and merging

`scm_post_pr_comment`, `scm_list_pr_comments`, and approval all work, but they
write to the local store — no one is notified, and there is no web UI to open.
There is no external reviewer to wait for.

`scm_merge_pr` marks the stored record merged. It deliberately does **not**
merge anything in the user's repository: Coro does not rewrite branches a
person may have checked out.

## What the final artifact must say

Because the merge never happens automatically, the job's closing summary has
to tell the user what they have and what to do with it. State the branch name
and the repository path, and that reviewing and merging is theirs to do —
for example:

> Branch `coro/add-rate-limiting` is now in `/Users/someone/code/my-service`.
> Review and merge it with your normal tools.

Do not describe the job as "merged" or link to a pull request URL; neither
exists in local mode.
