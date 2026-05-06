# GitLab clone recipe

When the active SCM plugin is `gitlab`, clone repositories using the
URL returned by `cloneInfo` — it embeds the configured personal access
token via the `oauth2:<token>@gitlab.example.com/<namespace>/<repo>.git`
shape, which works for both gitlab.com and self-managed instances.

Always run `git clone` with `GIT_TERMINAL_PROMPT=0` (the `envForGit`
the plugin returns) so a misconfigured token surfaces as a hard
failure instead of an interactive password prompt.
