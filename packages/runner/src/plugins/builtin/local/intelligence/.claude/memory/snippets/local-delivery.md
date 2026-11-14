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

That path is the user's own working copy. Jobs can read it but cannot write to
it, so always `scm_clone_repo` first and do every branch, edit and build in the
clone. Never `cd` into the original to work.

## Coder: commit in the job checkout; never push

Commit with separate unchained Bash calls inside the job checkout
(`git -C <repoCheckoutDir> add` / `commit`). Then **do not run `git push`**.

The clone's `origin` is the user's repository, outside the job directory. A
host sandbox refuses that write (`remote unpack failed: unable to create
temporary object directory`, `EPERM`), and a host permission policy may hold
`git push` for an interactive prompt nobody can answer. Neither is a coding
failure, and neither is a reason to escalate: the runner delivers the branch
for you. Commit, post the `pr-preview` artefact, and end the coding turn. Do
not call `scm_create_pr` yourself.

The same holds in a fix loop after review: commit the fix on the same branch
and hand back to review. The runner re-delivers it.

## Opening a pull request

`scm_create_pr` (review phase) does two things:

1. Pushes your branch from the job checkout into the user's repository. The
   push runs in the runner process, outside the agent's sandbox and
   permission rules.
2. Records an open pull request in a local JSON store so status, comments,
   and approval have somewhere to live.

It is idempotent: calling it again for a branch that already has an open pull
request re-pushes the branch and returns the same pull request.

The push inside `scm_create_pr` is the part that matters. If **that** tool
fails, the work never reached the user — treat the error as fatal for the
review phase rather than continuing.

Push only the branch you created. Git refuses a push to the branch the target
repository currently has checked out, and that refusal is correct: it would
corrupt someone's working tree.

## Reviews and merging

`scm_post_pr_comment`, `scm_list_pr_comments`, and approval all work, but they
write to the local store — no one is notified, and there is no web UI to open.
There is no external reviewer to wait for.

`scm_merge_pr` re-pushes the branch from the job checkout, so fix-loop
commits reach the user, then marks the stored record merged. It deliberately
does **not** merge anything in the user's repository: Coro does not rewrite
branches a person may have checked out.

## What the final artifact must say

Because the merge never happens automatically, the job's closing summary has
to tell the user what they have and what to do with it. State the branch name
and the repository path, and that reviewing and merging is theirs to do —
for example:

> Branch `coro/add-rate-limiting` is now in `/Users/someone/code/my-service`.
> Review and merge it with your normal tools.

Do not describe the job as "merged" or link to a pull request URL; neither
exists in local mode.
