const vscode = require('vscode');
const { exec, execFile } = require('child_process');
const path = require('path');

const GIT_OUTPUT_LIMIT = 1024 * 1024;

const GitContentProvider = new (class {
    provideTextDocumentContent(uri) {
        const rootPath = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
        const [ref, ...pathParts] = uri.path.split('/');
        const filePath = pathParts.join('/');

        return new Promise((resolve) => {
            exec(`git show ${ref}:${filePath}`, { cwd: rootPath }, (err, stdout) => {
                if (err) resolve('Error: File does not exist in this reference.');
                else resolve(stdout);
            });
        });
    }
})();

function activate(context) {
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider('git-content', GitContentProvider)
    );

    const rootPath = () => vscode.workspace.workspaceFolders?.[0].uri.fsPath;

    context.subscriptions.push(vscode.commands.registerCommand('super-git-helper.localMenu', () => {
        if (!rootPath()) return vscode.window.showErrorMessage('Open a project!');
        showBranchList(rootPath(), 'LOCAL');
    }));

    context.subscriptions.push(vscode.commands.registerCommand('super-git-helper.remoteMenu', () => {
        if (!rootPath()) return vscode.window.showErrorMessage('Open a project!');
        showBranchList(rootPath(), 'REMOTE');
    }));

    context.subscriptions.push(vscode.commands.registerCommand('super-git-helper.createBranch', async () => {
        if (!rootPath()) return vscode.window.showErrorMessage('Open a project!');
        const name = await vscode.window.showInputBox({ prompt: 'New branch name' });
        if (name) runGit(`git checkout -b ${name}`, rootPath(), `Created ${name}`);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('super-git-helper.listChangedFiles', async () => {
        if (!rootPath()) return vscode.window.showErrorMessage('Open a project!');
        await listChangedFilesLogic(rootPath());
    }));

    context.subscriptions.push(vscode.commands.registerCommand('super-git-helper.cherryPickCommit', async () => {
        if (!rootPath()) return vscode.window.showErrorMessage('Open a project!');
        await cherryPickCommitLogic(rootPath());
    }));

    context.subscriptions.push(vscode.commands.registerCommand('super-git-helper.rollbackCommit', async () => {
        if (!rootPath()) return vscode.window.showErrorMessage('Open a project!');
        await rollbackCommitLogic(rootPath());
    }));

    context.subscriptions.push(vscode.commands.registerCommand('super-git-helper.rebaseCurrentBranch', async () => {
        if (!rootPath()) return vscode.window.showErrorMessage('Open a project!');
        await rebaseCurrentBranchLogic(rootPath());
    }));

    context.subscriptions.push(vscode.commands.registerCommand('super-git-helper.commitChanges', async () => {
        if (!rootPath()) return vscode.window.showErrorMessage('Open a project!');
        await commitChangesLogic(rootPath());
    }));

    context.subscriptions.push(vscode.commands.registerCommand('super-git-helper.createRemoteBranch', async () => {
        if (!rootPath()) return vscode.window.showErrorMessage('Open a project!');
        await createRemoteBranchLogic(rootPath());
    }));

    context.subscriptions.push(vscode.commands.registerCommand('super-git-helper.pushBranch', async () => {
        if (!rootPath()) return vscode.window.showErrorMessage('Open a project!');
        await pushBranchLogic(rootPath());
    }));
}

async function listChangedFilesLogic(rootPath) {
    exec('git status --short', { cwd: rootPath }, async (err, stdout) => {
        if (err) return vscode.window.showErrorMessage('Git Status Error: ' + err.message);

        const files = stdout.split('\n')
            .filter((line) => line.trim() !== '')
            .map((line) => {
                const status = line.substring(0, 2).trim();
                const filePath = line.substring(3).trim();
                return {
                    label: `$(file-code) ${filePath}`,
                    detail: `Status: ${status}`,
                    filePath
                };
            });

        if (files.length === 0) {
            return vscode.window.showInformationMessage('No changes detected in this repo.');
        }

        const selected = await vscode.window.showQuickPick(files, {
            title: 'Step 1: Select File to Compare'
        });
        if (!selected) return;

        const mode = await vscode.window.showQuickPick([
            { label: 'Compare with HEAD (Uncommitted changes)', id: 'HEAD' },
            { label: 'Compare with another Branch...', id: 'BRANCH' }
        ], { title: 'Step 2: Choose Reference' });

        if (!mode) return;

        if (mode.id === 'HEAD') {
            diffWithReference(rootPath, selected.filePath, 'HEAD');
        } else {
            exec('git branch -a', { cwd: rootPath }, async (err, stdout) => {
                if (err) return vscode.window.showErrorMessage(err.message);

                const branches = stdout.split('\n')
                    .map((branch) => branch.replace('*', '').trim())
                    .filter((branch) => branch !== '');

                const targetBranch = await vscode.window.showQuickPick(branches, {
                    title: 'Step 3: Pick Branch to Compare Against'
                });

                if (targetBranch) {
                    diffWithReference(rootPath, selected.filePath, targetBranch);
                }
            });
        }
    });
}

async function cherryPickCommitLogic(rootPath) {
    const commitRef = await vscode.window.showInputBox({
        prompt: 'Commit SHA to cherry-pick into the current branch',
        placeHolder: 'Example: a1b2c3d or full commit SHA',
        validateInput: (value) => {
            if (!value.trim()) return 'Enter a commit SHA.';
            if (!/^[0-9a-fA-F]+$/.test(value.trim())) return 'Commit SHA should only contain hex characters.';
            return null;
        }
    });

    if (!commitRef) return;

    try {
        const currentBranch = await gitOutput(rootPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
        const inspection = await inspectCommit(rootPath, commitRef.trim(), 'Preparing cherry-pick');

        const sourceBranch = await pickSourceBranch(inspection.remoteBranches, inspection.localBranches);
        if (sourceBranch === undefined) return;

        if (sourceBranch && sourceBranch.type === 'remote') {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Fetching source branch',
                cancellable: false
            }, async () => {
                const { remoteName, branchName } = splitRemoteBranch(sourceBranch.name);
                await git(rootPath, ['fetch', remoteName, branchName]);
            });
        }

        const confirmation = [
            `Current branch: ${currentBranch}`,
            `Commit: ${inspection.commitInfo.shortSha} ${inspection.commitInfo.subject}`,
            `Author: ${inspection.commitInfo.author}`,
            `Date: ${inspection.commitInfo.date}`,
            `Source: ${formatSourceBranchLabel(sourceBranch)}`
        ].join('\n');

        const approved = await vscode.window.showWarningMessage(
            confirmation,
            { modal: true },
            'Apply Changes'
        );

        if (approved !== 'Apply Changes') return;

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Applying commit changes',
            cancellable: false
        }, async () => {
            await git(rootPath, ['cherry-pick', '--no-commit', inspection.commitInfo.sha]);
        });

        vscode.window.showInformationMessage(
            `Applied ${inspection.commitInfo.shortSha} onto ${currentBranch} without creating a commit.`
        );
    } catch (error) {
        const message = isCherryPickConflict(error.message)
            ? `${error.message}\nResolve conflicts, then run git cherry-pick --continue or git cherry-pick --abort.`
            : error.message;
        vscode.window.showErrorMessage(message);
    }
}

async function rollbackCommitLogic(rootPath) {
    const commitRef = await vscode.window.showInputBox({
        prompt: 'Commit SHA to roll back from the current branch',
        placeHolder: 'Example: a1b2c3d or full commit SHA',
        validateInput: (value) => {
            if (!value.trim()) return 'Enter a commit SHA.';
            if (!/^[0-9a-fA-F]+$/.test(value.trim())) return 'Commit SHA should only contain hex characters.';
            return null;
        }
    });

    if (!commitRef) return;

    try {
        const currentBranch = await requireCurrentBranch(rootPath);
        await ensureCleanWorktree(rootPath);
        const inspection = await inspectCommit(rootPath, commitRef.trim(), 'Preparing rollback');
        await ensureCommitCanBeDropped(rootPath, inspection.commitInfo.sha);
        const parentCommit = await getCommitParent(rootPath, inspection.commitInfo.sha);

        const confirmation = [
            `Current branch: ${currentBranch}`,
            `Rollback commit: ${inspection.commitInfo.shortSha} ${inspection.commitInfo.subject}`,
            `Author: ${inspection.commitInfo.author}`,
            `Date: ${inspection.commitInfo.date}`,
            'Warning: this rewrites branch history and removes the commit cleanly.'
        ].join('\n');

        const approved = await vscode.window.showWarningMessage(
            confirmation,
            { modal: true },
            'Apply Rollback'
        );

        if (approved !== 'Apply Rollback') return;

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Applying rollback',
            cancellable: false
        }, async () => {
            await git(rootPath, ['rebase', '--onto', parentCommit, inspection.commitInfo.sha]);
        });

        const currentUpstream = await tryGetUpstreamBranch(rootPath);
        const pushNote = currentUpstream
            ? ' If this branch was already pushed, the next push may require git push --force-with-lease.'
            : '';

        vscode.window.showInformationMessage(
            `Removed ${inspection.commitInfo.shortSha} from ${currentBranch}.${pushNote}`
        );
    } catch (error) {
        const message = isRollbackConflict(error.message)
            ? `${error.message}\nResolve conflicts, then run git rebase --continue, git rebase --skip, or git rebase --abort.`
            : error.message;
        vscode.window.showErrorMessage(message);
    }
}

async function rebaseCurrentBranchLogic(rootPath) {
    try {
        const currentBranch = await requireCurrentBranch(rootPath);
        await ensureCleanWorktree(rootPath);

        const mode = await vscode.window.showQuickPick([
            {
                label: 'Use upstream branch',
                id: 'UPSTREAM',
                detail: 'Rebase the current branch onto its configured @{upstream} branch'
            },
            {
                label: 'Choose another branch',
                id: 'SELECT',
                detail: 'Pick a local or remote branch to rebase onto'
            }
        ], {
            title: `Rebase ${currentBranch}: Choose target`
        });

        if (!mode) return;

        const target = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Preparing rebase',
            cancellable: false
        }, async (progress) => {
            progress.report({ message: 'Fetching remotes...' });
            await git(rootPath, ['fetch', '--all', '--prune']);

            if (mode.id === 'UPSTREAM') {
                const upstream = await getUpstreamBranch(rootPath);
                return {
                    name: upstream,
                    type: upstream.includes('/') ? 'remote' : 'local',
                    source: 'upstream'
                };
            }

            progress.report({ message: 'Loading branches...' });
            return pickRebaseTarget(rootPath, currentBranch);
        });

        if (!target) return;

        const confirmation = [
            `Current branch: ${currentBranch}`,
            `Rebase onto: ${target.name}`,
            `Target type: ${target.type}`,
            `Selection: ${target.source === 'upstream' ? 'configured upstream' : 'manual branch selection'}`,
            'Warning: rebase rewrites commit history.'
        ].join('\n');

        const approved = await vscode.window.showWarningMessage(
            confirmation,
            { modal: true },
            'Start Rebase'
        );

        if (approved !== 'Start Rebase') return;

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Rebasing ${currentBranch}`,
            cancellable: false
        }, async () => {
            await git(rootPath, ['rebase', target.name]);
        });

        const currentUpstream = await tryGetUpstreamBranch(rootPath);
        const pushNote = currentUpstream
            ? ' If this branch was already pushed, the next push may require git push --force-with-lease.'
            : '';

        vscode.window.showInformationMessage(
            `Rebased ${currentBranch} onto ${target.name}.${pushNote}`
        );
    } catch (error) {
        const message = isRebaseConflict(error.message)
            ? `${error.message}\nResolve conflicts, then run git rebase --continue, git rebase --skip, or git rebase --abort.`
            : error.message;
        vscode.window.showErrorMessage(message);
    }
}

async function commitChangesLogic(rootPath) {
    try {
        const currentBranch = await requireCurrentBranch(rootPath);
        await ensureNoStagedChanges(rootPath);

        const changedFiles = await getChangedFiles(rootPath);
        if (changedFiles.length === 0) {
            vscode.window.showInformationMessage('No changed files are available to commit.');
            return;
        }

        ensureNoUnmergedFiles(changedFiles);

        const selectedFiles = await pickFilesToCommit(changedFiles);
        if (!selectedFiles || selectedFiles.length === 0) return;

        const commitPlan = await collectCommitPlan(rootPath, currentBranch, selectedFiles);
        if (!commitPlan) return;

        const confirmation = buildCommitConfirmation(currentBranch, selectedFiles, commitPlan);
        const approved = await vscode.window.showWarningMessage(
            confirmation,
            { modal: true },
            commitPlan.type === 'amend' ? 'Commit Amend' : 'Create Commit'
        );

        const expectedAction = commitPlan.type === 'amend' ? 'Commit Amend' : 'Create Commit';
        if (approved !== expectedAction) return;

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: commitPlan.type === 'amend' ? 'Amending commit' : 'Creating commit',
            cancellable: false
        }, async () => {
            await git(rootPath, ['add', '--', ...selectedFiles.map((file) => file.path)]);
            await git(rootPath, buildCommitArgs(commitPlan));
        });

        const summary = await getHeadCommitSummary(rootPath);
        vscode.window.showInformationMessage(
            `${commitPlan.type === 'amend' ? 'Amended' : 'Created'} ${summary.shortSha}: ${summary.subject}`
        );
    } catch (error) {
        vscode.window.showErrorMessage(error.message);
    }
}

async function createRemoteBranchLogic(rootPath) {
    try {
        const currentBranch = await requireCurrentBranch(rootPath);
        const remoteName = await pickRemoteName(rootPath, 'Create Remote Branch: Select remote');
        if (!remoteName) return;

        const remoteBranchName = await promptForRemoteBranchName(rootPath, remoteName, currentBranch);

        if (!remoteBranchName) return;

        const branchName = remoteBranchName.trim();
        const remoteBranchExists = await hasRemoteBranch(rootPath, remoteName, branchName);
        const action = remoteBranchExists ? 'Push and Track' : 'Create and Track';
        const confirmation = [
            `Current branch: ${currentBranch}`,
            `Remote: ${remoteName}`,
            `Remote branch: ${branchName}`,
            remoteBranchExists
                ? 'Warning: this remote branch already exists and will be updated if the push succeeds.'
                : 'This will create the remote branch and set it as upstream.'
        ].join('\n');

        const approved = await vscode.window.showWarningMessage(
            confirmation,
            { modal: true },
            action
        );

        if (approved !== action) return;

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `${remoteBranchExists ? 'Pushing' : 'Creating'} ${remoteName}/${branchName}`,
            cancellable: false
        }, async () => {
            await git(rootPath, ['push', '-u', remoteName, `HEAD:${branchName}`]);
        });

        vscode.window.showInformationMessage(
            `${remoteBranchExists ? 'Updated' : 'Created'} ${remoteName}/${branchName} and set it as upstream for ${currentBranch}.`
        );
    } catch (error) {
        vscode.window.showErrorMessage(error.message);
    }
}

async function pushBranchLogic(rootPath) {
    try {
        const currentBranch = await requireCurrentBranch(rootPath);
        const remoteName = await pickRemoteName(rootPath, 'Push Branch: Select remote');
        if (!remoteName) return;

        const remoteBranchName = await promptForRemoteBranchName(rootPath, remoteName, currentBranch);
        if (!remoteBranchName) return;

        const branchName = remoteBranchName.trim();
        const remoteBranchExists = await hasRemoteBranch(rootPath, remoteName, branchName);
        const action = remoteBranchExists ? 'Push Branch' : 'Create and Push';
        const confirmation = [
            `Current branch: ${currentBranch}`,
            `Remote: ${remoteName}`,
            `Remote branch: ${branchName}`,
            remoteBranchExists
                ? 'This will push the current branch onto the existing remote branch.'
                : 'This will create the remote branch by pushing the current branch to it.'
        ].join('\n');

        const approved = await vscode.window.showWarningMessage(
            confirmation,
            { modal: true },
            action
        );

        if (approved !== action) return;

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `${remoteBranchExists ? 'Pushing' : 'Creating and pushing'} ${remoteName}/${branchName}`,
            cancellable: false
        }, async () => {
            await git(rootPath, ['push', remoteName, `HEAD:${branchName}`]);
        });

        vscode.window.showInformationMessage(
            `${remoteBranchExists ? 'Pushed' : 'Created and pushed'} ${currentBranch} to ${remoteName}/${branchName}.`
        );
    } catch (error) {
        vscode.window.showErrorMessage(error.message);
    }
}

function isCherryPickConflict(message) {
    return /conflict/i.test(message) || message.includes('cherry-pick --continue');
}

function isRebaseConflict(message) {
    return /conflict/i.test(message) || message.includes('rebase --continue') || message.includes('Resolve all conflicts');
}

function isRollbackConflict(message) {
    return isRebaseConflict(message);
}

function ensureNoUnmergedFiles(changedFiles) {
    const unmergedCodes = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
    const conflicted = changedFiles.find((file) => unmergedCodes.has(`${file.indexStatus}${file.worktreeStatus}`));

    if (conflicted) {
        throw new Error('Resolve merge conflicts before using Commit Changes.');
    }
}

async function inspectCommit(rootPath, commitRef, title) {
    return vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title,
        cancellable: false
    }, async (progress) => {
        progress.report({ message: 'Fetching remotes...' });
        await git(rootPath, ['fetch', '--all', '--prune']);

        progress.report({ message: 'Reading commit info...' });
        const commitInfo = await getCommitInfo(rootPath, commitRef);

        progress.report({ message: 'Resolving candidate branches...' });
        const remoteBranches = await getContainingBranches(rootPath, commitRef, true);
        const localBranches = await getContainingBranches(rootPath, commitRef, false);

        return { commitInfo, remoteBranches, localBranches };
    });
}

async function getCommitInfo(rootPath, commitRef) {
    const format = ['%H', '%h', '%s', '%an', '%ad'].join('%n');
    const output = await gitOutput(rootPath, ['show', '-s', `--format=${format}`, commitRef]);
    const [sha, shortSha, subject, author, date] = output.split('\n');

    if (!sha) {
        throw new Error(`Commit ${commitRef} was not found after fetch.`);
    }

    return { sha, shortSha, subject, author, date };
}

async function getContainingBranches(rootPath, commitRef, remoteOnly) {
    const args = remoteOnly
        ? ['branch', '-r', '--contains', commitRef]
        : ['branch', '--contains', commitRef];
    const output = await gitOutput(rootPath, args);

    return output.split('\n')
        .map((branch) => branch.replace('*', '').trim())
        .filter((branch) => branch !== '' && !branch.includes('->'))
        .map((branch) => ({
            name: branch,
            type: remoteOnly ? 'remote' : 'local'
        }));
}

async function getChangedFiles(rootPath) {
    const { stdout } = await git(rootPath, ['status', '--porcelain=1', '-z']);
    return parsePorcelainStatus(stdout);
}

function parsePorcelainStatus(output) {
    const entries = [];
    let offset = 0;

    while (offset < output.length) {
        if (!output[offset]) break;

        const indexStatus = output[offset];
        const worktreeStatus = output[offset + 1];
        offset += 3;

        let pathEnd = output.indexOf('\0', offset);
        if (pathEnd === -1) {
            pathEnd = output.length;
        }

        const path = output.slice(offset, pathEnd);
        offset = pathEnd + 1;

        let originalPath = null;
        if (indexStatus === 'R' || indexStatus === 'C') {
            let originalEnd = output.indexOf('\0', offset);
            if (originalEnd === -1) {
                originalEnd = output.length;
            }

            originalPath = output.slice(offset, originalEnd);
            offset = originalEnd + 1;
        }

        entries.push({
            path,
            originalPath,
            indexStatus,
            worktreeStatus,
            code: `${indexStatus}${worktreeStatus}`.trim() || '??',
            label: originalPath ? `${originalPath} -> ${path}` : path
        });
    }

    return entries;
}

async function getBranchRefs(rootPath, remoteOnly) {
    const args = remoteOnly ? ['branch', '-r'] : ['branch'];
    const output = await gitOutput(rootPath, args);

    return output.split('\n')
        .map((branch) => branch.replace('*', '').trim())
        .filter((branch) => branch !== '' && !branch.includes('->'))
        .map((branch) => ({
            name: branch,
            type: remoteOnly ? 'remote' : 'local'
        }));
}

async function pickRebaseTarget(rootPath, currentBranch) {
    const localBranches = await getBranchRefs(rootPath, false);
    const remoteBranches = await getBranchRefs(rootPath, true);

    const branchItems = [...localBranches, ...remoteBranches]
        .filter((branch) => branch.name !== currentBranch)
        .map((branch) => ({
            label: branch.name,
            detail: branch.type === 'remote' ? 'Remote branch' : 'Local branch',
            branch
        }));

    if (branchItems.length === 0) {
        throw new Error('No rebase targets are available.');
    }

    const selected = await vscode.window.showQuickPick(branchItems, {
        title: `Rebase ${currentBranch}: Pick target branch`
    });

    if (!selected) return undefined;

    return {
        ...selected.branch,
        source: 'manual'
    };
}

async function pickFilesToCommit(changedFiles) {
    const selected = await vscode.window.showQuickPick(
        changedFiles.map((file) => ({
            label: file.label,
            description: file.code,
            detail: buildCommitFileDetail(file),
            file
        })),
        {
            canPickMany: true,
            title: 'Commit Changes: Select files to stage'
        }
    );

    return selected?.map((item) => item.file);
}

function buildCommitFileDetail(file) {
    const staged = file.indexStatus === ' ' ? 'no' : file.indexStatus;
    const unstaged = file.worktreeStatus === ' ' ? 'no' : file.worktreeStatus;
    return `Index: ${staged}  Worktree: ${unstaged}`;
}

async function collectCommitPlan(rootPath, currentBranch, selectedFiles) {
    const mode = await vscode.window.showQuickPick([
        {
            label: 'New commit',
            id: 'new',
            detail: `Create a new commit on ${currentBranch}`
        },
        {
            label: 'Amend previous commit',
            id: 'amend',
            detail: 'Amend HEAD with the selected files'
        }
    ], {
        title: 'Commit Changes: Choose commit mode'
    });

    if (!mode) return null;

    if (mode.id === 'new') {
        const message = await promptForCommitMessage('Commit message');
        if (!message) return null;
        return { type: 'new', message };
    }

    await ensureHeadCommitExists(rootPath);

    const amendMode = await vscode.window.showQuickPick([
        {
            label: 'Keep previous message',
            id: 'keep',
            detail: 'Amend HEAD without changing its commit message'
        },
        {
            label: 'Edit commit message',
            id: 'edit',
            detail: 'Amend HEAD and replace its commit message'
        }
    ], {
        title: 'Commit Changes: Amend options'
    });

    if (!amendMode) return null;

    if (amendMode.id === 'keep') {
        return { type: 'amend', amendMode: 'keep' };
    }

    const previousMessage = await getHeadCommitMessage(rootPath);
    const message = await promptForCommitMessage('New commit message', previousMessage);
    if (!message) return null;
    return { type: 'amend', amendMode: 'edit', message };
}

function buildCommitConfirmation(currentBranch, selectedFiles, commitPlan) {
    const summary = selectedFiles.length === 1
        ? selectedFiles[0].label
        : `${selectedFiles.length} files selected`;
    const action = commitPlan.type === 'amend'
        ? commitPlan.amendMode === 'keep'
            ? 'Amend previous commit and keep its message'
            : 'Amend previous commit with a new message'
        : `Create a new commit: ${commitPlan.message}`;

    return [
        `Current branch: ${currentBranch}`,
        `Files: ${summary}`,
        `Action: ${action}`
    ].join('\n');
}

function buildCommitArgs(commitPlan) {
    if (commitPlan.type === 'new') {
        return ['commit', '-m', commitPlan.message];
    }

    if (commitPlan.amendMode === 'keep') {
        return ['commit', '--amend', '--no-edit'];
    }

    return ['commit', '--amend', '-m', commitPlan.message];
}

async function pickSourceBranch(remoteBranches, localBranches) {
    if (remoteBranches.length === 1) return remoteBranches[0];

    if (remoteBranches.length > 1) {
        const selected = await vscode.window.showQuickPick(
            remoteBranches.map((branch) => ({
                label: branch.name,
                detail: 'Remote branch containing this commit',
                branch
            })),
            {
                title: 'Select the source branch for this commit'
            }
        );
        return selected?.branch;
    }

    if (localBranches.length === 1) return localBranches[0];

    if (localBranches.length > 1) {
        const selected = await vscode.window.showQuickPick(
            localBranches.map((branch) => ({
                label: branch.name,
                detail: 'Local branch containing this commit',
                branch
            })),
            {
                title: 'No remote branch found. Pick a local branch'
            }
        );
        return selected?.branch;
    }

    const proceed = await vscode.window.showWarningMessage(
        'No branch containing this commit was found. Continue and cherry-pick the commit directly?',
        { modal: true },
        'Continue'
    );

    if (proceed !== 'Continue') return undefined;
    return null;
}

function splitRemoteBranch(branchName) {
    const [remoteName, ...branchParts] = branchName.split('/');

    if (!remoteName || branchParts.length === 0) {
        throw new Error(`Unable to parse remote branch: ${branchName}`);
    }

    return {
        remoteName,
        branchName: branchParts.join('/')
    };
}

function formatSourceBranchLabel(sourceBranch) {
    return sourceBranch ? sourceBranch.name : 'commit found, branch unknown';
}

async function requireCurrentBranch(rootPath) {
    const currentBranch = await gitOutput(rootPath, ['rev-parse', '--abbrev-ref', 'HEAD']);

    if (currentBranch === 'HEAD') {
        throw new Error('Detached HEAD is not supported. Check out a branch before rebasing.');
    }

    return currentBranch;
}

async function ensureCleanWorktree(rootPath) {
    const status = await gitOutput(rootPath, ['status', '--short']);

    if (status) {
        throw new Error('Rebase requires a clean working tree. Commit, stash, or discard changes first.');
    }
}

async function ensureNoStagedChanges(rootPath) {
    const staged = await gitOutput(rootPath, ['diff', '--cached', '--name-only']);

    if (staged) {
        throw new Error('Commit Changes requires no pre-existing staged files. Commit, unstage, or discard them first.');
    }
}

async function getUpstreamBranch(rootPath) {
    try {
        return await gitOutput(rootPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
    } catch (error) {
        throw new Error('This branch has no configured upstream. Choose another branch or set upstream first.');
    }
}

async function tryGetUpstreamBranch(rootPath) {
    try {
        return await gitOutput(rootPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
    } catch (error) {
        return null;
    }
}

async function pickRemoteName(rootPath, title) {
    const remoteNames = await getRemoteNames(rootPath);

    if (remoteNames.length === 0) {
        throw new Error('No Git remotes are configured for this repository.');
    }

    const upstream = await tryGetUpstreamBranch(rootPath);
    const upstreamRemoteName = upstream ? splitRemoteBranch(upstream).remoteName : null;

    if (remoteNames.length === 1) {
        return remoteNames[0];
    }

    const selected = await vscode.window.showQuickPick(
        remoteNames.map((remoteName) => ({
            label: remoteName,
            detail: remoteName === upstreamRemoteName ? 'Current upstream remote' : 'Available Git remote'
        })),
        {
            title
        }
    );

    return selected?.label;
}

async function promptForRemoteBranchName(rootPath, remoteName, defaultBranchName) {
    const suggestions = await getRemoteBranchNameSuggestions(rootPath, remoteName, defaultBranchName);

    return new Promise((resolve) => {
        const quickPick = vscode.window.createQuickPick();
        let settled = false;
        quickPick.title = `Remote branch name for ${remoteName}`;
        quickPick.placeholder = 'Select a suggested branch name or type a custom one';
        quickPick.matchOnDescription = true;
        quickPick.value = defaultBranchName;
        quickPick.items = suggestions.map((suggestion) => ({
            label: suggestion.name,
            description: suggestion.description
        }));

        const finish = (value) => {
            if (settled) return;
            settled = true;
            quickPick.dispose();
            resolve(value);
        };

        quickPick.onDidAccept(() => {
            const selectedLabel = quickPick.selectedItems[0]?.label;
            const typedValue = quickPick.value.trim();
            const branchName = (selectedLabel || typedValue).trim();

            if (!branchName) {
                vscode.window.showErrorMessage('Remote branch name cannot be empty.');
                return;
            }

            if (/\s/.test(branchName)) {
                vscode.window.showErrorMessage('Remote branch name cannot contain spaces.');
                return;
            }

            quickPick.hide();
            finish(branchName);
        });

        quickPick.onDidHide(() => {
            finish(undefined);
        });

        quickPick.show();
    });
}

async function getRemoteBranchNameSuggestions(rootPath, remoteName, defaultBranchName) {
    const suggestions = new Map();
    const addSuggestion = (name, description) => {
        const branchName = name.trim();
        if (!branchName || suggestions.has(branchName)) return;
        suggestions.set(branchName, { name: branchName, description });
    };

    addSuggestion(defaultBranchName, 'Current local branch name');

    const upstream = await tryGetUpstreamBranch(rootPath);
    if (upstream) {
        const { remoteName: upstreamRemote, branchName } = splitRemoteBranch(upstream);
        if (upstreamRemote === remoteName) {
            addSuggestion(branchName, 'Current upstream branch name');
        }
    }

    const remoteBranches = await getRemoteBranchNames(rootPath, remoteName);
    for (const branchName of remoteBranches) {
        if (branchName === defaultBranchName) {
            addSuggestion(branchName, 'Existing remote branch with the same name');
            continue;
        }

        if (branchName.startsWith(defaultBranchName) || defaultBranchName.startsWith(branchName)) {
            addSuggestion(branchName, 'Existing similar remote branch');
        }
    }

    for (const branchName of remoteBranches) {
        addSuggestion(branchName, 'Existing remote branch');
    }

    return Array.from(suggestions.values());
}

async function getRemoteBranchNames(rootPath, remoteName) {
    const output = await gitOutput(rootPath, ['branch', '-r', '--list', `${remoteName}/*`]);
    return output
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.includes('->'))
        .map((line) => splitRemoteBranch(line).branchName);
}

async function getRemoteNames(rootPath) {
    const output = await gitOutput(rootPath, ['remote']);
    return output
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');
}

async function hasRemoteBranch(rootPath, remoteName, branchName) {
    try {
        const output = await gitOutput(rootPath, ['ls-remote', '--heads', remoteName, branchName]);
        return output !== '';
    } catch (error) {
        return false;
    }
}

async function ensureCommitCanBeDropped(rootPath, commitRef) {
    const isOnCurrentBranch = await isCommitAncestorOfHead(rootPath, commitRef);
    if (!isOnCurrentBranch) {
        throw new Error('Rollback Commit only supports commits that are on the current branch history.');
    }

    const parentLine = await gitOutput(rootPath, ['rev-list', '--parents', '-n', '1', commitRef]);
    const parts = parentLine.split(' ').filter(Boolean);

    if (parts.length === 1) {
        throw new Error('Rollback Commit does not support removing the root commit.');
    }

    if (parts.length > 2) {
        throw new Error('Rollback Commit does not support merge commits.');
    }
}

async function isCommitAncestorOfHead(rootPath, commitRef) {
    try {
        await git(rootPath, ['merge-base', '--is-ancestor', commitRef, 'HEAD']);
        return true;
    } catch (error) {
        return false;
    }
}

async function getCommitParent(rootPath, commitRef) {
    return gitOutput(rootPath, ['rev-parse', `${commitRef}^`]);
}

async function ensureHeadCommitExists(rootPath) {
    try {
        await gitOutput(rootPath, ['rev-parse', '--verify', 'HEAD']);
    } catch (error) {
        throw new Error('There is no previous commit to amend yet.');
    }
}

async function getHeadCommitMessage(rootPath) {
    return gitOutput(rootPath, ['log', '-1', '--pretty=%B']);
}

async function getHeadCommitSummary(rootPath) {
    const output = await gitOutput(rootPath, ['show', '-s', '--format=%h%n%s', 'HEAD']);
    const [shortSha, subject] = output.split('\n');
    return { shortSha, subject };
}

async function promptForCommitMessage(prompt, value = '') {
    const message = await vscode.window.showInputBox({
        prompt,
        value,
        validateInput: (input) => input.trim() ? null : 'Commit message cannot be empty.'
    });

    return message?.trim() || null;
}

async function diffWithReference(rootPath, filePath, reference) {
    const rightSide = vscode.Uri.file(path.join(rootPath, filePath));
    const leftSide = vscode.Uri.parse(`git-content:${reference}/${filePath}`);

    try {
        await vscode.commands.executeCommand(
            'vscode.diff',
            leftSide,
            rightSide,
            `${filePath} (Diff vs ${reference})`
        );
    } catch (e) {
        vscode.window.showErrorMessage('Diff failed: ' + e.message);
    }
}

async function showBranchList(rootPath, type) {
    const cmd = type === 'LOCAL' ? 'git branch' : 'git branch -r';

    exec(cmd, { cwd: rootPath }, async (err, stdout) => {
        if (err) return vscode.window.showErrorMessage(err.message);

        const branches = stdout.split('\n')
            .map((branch) => branch.replace('*', '').trim())
            .filter((branch) => branch !== '' && !branch.includes('->'));

        const selectedBranch = await vscode.window.showQuickPick(branches, {
            placeHolder: `Select a ${type.toLowerCase()} branch`,
            title: `Git Helper: ${type} Branches`
        });

        if (!selectedBranch) return;

        if (type === 'REMOTE') {
            const action = await vscode.window.showQuickPick([
                {
                    label: '$(plus) Create local branch from this',
                    id: 'CREATE_TRACK',
                    detail: `Will create a local branch linked to ${selectedBranch}`
                },
                {
                    label: '$(trash) Delete remote branch',
                    id: 'DELETE_REMOTE',
                    detail: 'Warning: This deletes the branch on the server!'
                },
                {
                    label: '$(clippy) Copy name',
                    id: 'COPY'
                }
            ], { title: `Actions for ${selectedBranch}` });

            if (!action) return;

            if (action.id === 'CREATE_TRACK') {
                const suggestedName = selectedBranch.replace(/^[^/]+\//, '');
                const localName = await vscode.window.showInputBox({
                    prompt: 'Enter local branch name:',
                    value: suggestedName
                });

                if (localName) {
                    runGit(
                        `git checkout -b ${localName} --track ${selectedBranch}`,
                        rootPath,
                        `Created ${localName} tracking ${selectedBranch}`
                    );
                }
            } else if (action.id === 'DELETE_REMOTE') {
                const [remote, ...branchParts] = selectedBranch.split('/');
                const branchName = branchParts.join('/');

                const confirm = await vscode.window.showWarningMessage(
                    `Are you sure you want to delete ${selectedBranch} from the server?`,
                    'Yes',
                    'No'
                );

                if (confirm === 'Yes') {
                    runGit(
                        `git push ${remote} --delete ${branchName}`,
                        rootPath,
                        `Deleted remote branch ${selectedBranch}`
                    );
                }
            } else if (action.id === 'COPY') {
                vscode.env.clipboard.writeText(selectedBranch);
                vscode.window.showInformationMessage('Copied to clipboard!');
            }
        } else {
            const action = await vscode.window.showQuickPick(['Checkout', 'Delete (Safe)', 'Delete (Force)']);
            if (action === 'Checkout') runGit(`git checkout ${selectedBranch}`, rootPath, `Switched to ${selectedBranch}`);
            if (action === 'Delete (Safe)') runGit(`git branch -d ${selectedBranch}`, rootPath, `Deleted ${selectedBranch}`);
            if (action === 'Delete (Force)') runGit(`git branch -D ${selectedBranch}`, rootPath, `Force deleted ${selectedBranch}`);
        }
    });
}

function git(rootPath, args) {
    return new Promise((resolve, reject) => {
        execFile('git', args, { cwd: rootPath, maxBuffer: GIT_OUTPUT_LIMIT }, (err, stdout, stderr) => {
            if (err) {
                reject(new Error((stderr || stdout || err.message).trim() || err.message));
                return;
            }

            resolve({ stdout, stderr });
        });
    });
}

async function gitOutput(rootPath, args) {
    const { stdout } = await git(rootPath, args);
    return stdout.trim();
}

function runGit(command, cwd, successMsg) {
    exec(command, { cwd }, (err, stdout, stderr) => {
        if (err) return vscode.window.showErrorMessage(stderr || err.message);
        vscode.window.showInformationMessage(successMsg);
    });
}

exports.activate = activate;
