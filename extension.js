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
        const currentBranch = await gitOutput(rootPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
        const inspection = await inspectCommit(rootPath, commitRef.trim(), 'Preparing rollback');

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
            `Rollback commit: ${inspection.commitInfo.shortSha} ${inspection.commitInfo.subject}`,
            `Author: ${inspection.commitInfo.author}`,
            `Date: ${inspection.commitInfo.date}`,
            `Source: ${formatSourceBranchLabel(sourceBranch)}`
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
            await git(rootPath, ['revert', '--no-commit', inspection.commitInfo.sha]);
        });

        vscode.window.showInformationMessage(
            `Applied rollback for ${inspection.commitInfo.shortSha} onto ${currentBranch} without creating a commit.`
        );
    } catch (error) {
        const message = isRevertConflict(error.message)
            ? `${error.message}\nResolve conflicts, then run git revert --continue or git revert --abort.`
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

function isCherryPickConflict(message) {
    return /conflict/i.test(message) || message.includes('cherry-pick --continue');
}

function isRevertConflict(message) {
    return /conflict/i.test(message) || message.includes('revert --continue');
}

function isRebaseConflict(message) {
    return /conflict/i.test(message) || message.includes('rebase --continue') || message.includes('Resolve all conflicts');
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
