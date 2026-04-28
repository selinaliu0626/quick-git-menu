# Quick Git Menu

`Quick Git Menu` is a small VS Code extension for common Git actions that are easier to use from a sidebar than from the terminal.

In VS Code, the extension appears as **Super Git Helper** in the activity bar and opens a **Git Actions** view with quick links for branch and diff operations.

## Features

- Browse local branches and quickly:
  - check out a branch
  - delete a branch safely
  - force delete a branch
- Browse remote branches and:
  - create a local tracking branch
  - delete a remote branch
  - copy a branch name
- Create a new branch from the current branch
- List changed files and compare them:
  - against `HEAD`
  - against another branch
- Cherry-pick a commit by SHA after fetching remotes, inspecting commit details, and selecting a source branch when multiple branches contain the commit

## Commands

The extension contributes these commands:

- `Show Local Branches`
- `Show Remote Branches`
- `Create New Branch`
- `View Changed Files`
- `Cherry Pick Commit`

## How It Works

The extension uses the first open workspace folder as the Git repo root and runs standard Git commands behind the scenes, including:

- `git branch`
- `git branch -r`
- `git checkout`
- `git checkout -b`
- `git cherry-pick`
- `git push --delete`
- `git status --short`
- `git show`

## Development

1. Open this folder in VS Code.
2. Press `F5` to launch an Extension Development Host.
3. Open a Git repository in the new window.
4. Use the **Super Git** activity bar icon to access the sidebar.

## Notes

- This extension currently assumes the first workspace folder is the target repository.
- It depends on Git being installed and available on your system `PATH`.
