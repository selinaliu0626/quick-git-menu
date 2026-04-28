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
        const inspection = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Preparing cherry-pick',
            cancellable: false
        }, async (progress) => {
            progress.report({ message: 'Fetching remotes...' });
            await git(rootPath, ['fetch', '--all', '--prune']);

            progress.report({ message: 'Reading commit info...' });
            const commitInfo = await getCommitInfo(rootPath, commitRef.trim());

            progress.report({ message: 'Resolving candidate branches...' });
            const remoteBranches = await getContainingBranches(rootPath, commitRef.trim(), true);
            const localBranches = await getContainingBranches(rootPath, commitRef.trim(), false);

            return { commitInfo, remoteBranches, localBranches };
        });

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
            'Cherry Pick'
        );

        if (approved !== 'Cherry Pick') return;

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Cherry-picking commit',
            cancellable: false
        }, async () => {
            await git(rootPath, ['cherry-pick', inspection.commitInfo.sha]);
        });

        vscode.window.showInformationMessage(
            `Cherry-picked ${inspection.commitInfo.shortSha} into ${currentBranch}.`
        );
    } catch (error) {
        const message = isCherryPickConflict(error.message)
            ? `${error.message}\nResolve conflicts, then run git cherry-pick --continue or git cherry-pick --abort.`
            : error.message;
        vscode.window.showErrorMessage(message);
    }
}

function isCherryPickConflict(message) {
    return /conflict/i.test(message) || message.includes('cherry-pick --continue');
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
