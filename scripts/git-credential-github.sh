#!/bin/sh
# Git credential helper for GitHub over HTTPS.
#
# Supplies the Personal Access Token from the GITHUB_TOKEN environment
# variable to git's credential machinery only — the token is never written
# to .git/config, the remote URL, or this file. Without GITHUB_TOKEN set the
# helper yields nothing and git falls back to its usual prompts/failures.
#
# Enabled repo-locally via:
#   git config credential.helper "!sh scripts/git-credential-github-helper.sh"
#
# Token scopes needed for `git push`: classic PAT with `repo`, or a
# fine-grained PAT with Contents: read/write on the target repository.
case "$1" in
  get)
    [ -n "$GITHUB_TOKEN" ] || exit 0
    printf 'username=x-access-token\n'
    printf 'password=%s\n' "$GITHUB_TOKEN"
    ;;
  *)
    exit 0
    ;;
esac
