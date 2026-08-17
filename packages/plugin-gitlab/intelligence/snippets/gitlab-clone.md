# GitLab clone recipe

When the active SCM plugin is `gitlab`, clone repositories using the
URL returned by `cloneInfo` — a clean `https://gitlab.example.com/<namespace>/<repo>.git`
(or gitlab.com). The personal access token is supplied to git as the
`oauth2` password via the job credential helper, not embedded in `origin`.

Always run `git clone` with `GIT_TERMINAL_PROMPT=0` (the `envForGit`
the plugin returns) so a misconfigured token surfaces as a hard
failure instead of an interactive password prompt.
