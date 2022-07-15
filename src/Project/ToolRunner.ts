/*
 * Copyright (c) 2021 Samsung Electronics Co., Ltd. All Rights Reserved
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {strict as assert} from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import {dirname, join} from 'path';
import vscode from 'vscode';

import {Logger} from '../Utils/Logger';

import {ToolArgs} from './ToolArgs';

const path = require('path');
const which = require('which');

const K_DATA: string = 'data';
const K_EXIT: string = 'exit';

/**
 * Return type when a process exits without error
 * One of exitCode or intentionallyKilled must NOT be undefined.
 */
export interface SuccessResult {
  // When successful exit, exit code must be 0
  exitCode?: number;
  // When this process was intentionally killed by user, this must be true.
  intentionallyKilled?: boolean;
}

/**
 * Return type when a process exits with error
 * One of exitCode or signal must NOT be undefined.
 */
export interface ErrorResult {
  // Exit code must be greater than 0
  exitCode?: number;
  // When this process was killed by, e.g., kill command from shell,
  // this must be set to proper NodeJS.Signals.
  signal?: NodeJS.Signals;
}

/**
 * Class that creates a script(_pwScriptPath) to echos password into stdout.
 * This script is used to run sudo -A.
 *
 * Ref: https://github.com/Samsung/ONE-vscode/issues/988#issuecomment-1177340848
 *
 * Note: Specific class name (e.g., PasswordFileWriter) was not intentionally used
 *       because we don't want to log such string like 'password'.
 */
class TmpWriter {
  private _tag = this.constructor.name;  // logging tag

  private _pwScriptPath: string|undefined = undefined;

  create(pw: string) {
    const tmpDir = 'ptmp';
    const pwScriptFileName = 'sp.sh';  // 's'udo 'p'assword

    const extensionId = 'Samsung.one-vscode';
    const ext = vscode.extensions.getExtension(extensionId);

    if (ext === undefined) {
      throw Error(`Cannot find extensionId: ${extensionId}`);
    }

    const tmpPath = vscode.Uri.joinPath(ext.extensionUri, tmpDir).fsPath;

    if (!fs.existsSync(tmpPath)) {
      fs.mkdirSync(tmpPath);
    }

    this._pwScriptPath = join(tmpPath, pwScriptFileName);

    if (fs.existsSync(this._pwScriptPath)) {
      fs.unlinkSync(this._pwScriptPath);
    }

    // NOTE: mode is Linux only (Consider Windows if needed)
    let pwScriptFd = fs.openSync(this._pwScriptPath, 'w', 0o700);
    fs.writeSync(pwScriptFd, `#!/bin/bash\n`);
    fs.writeSync(pwScriptFd, `echo ${pw}\n`);

    // flush the file
    const tag = this._tag;
    fs.fdatasync(pwScriptFd, function() {
      Logger.info(tag, 'tmp dir was created');
    });
  }

  path() {
    return this._pwScriptPath!;
  }

  /**
   * Remove created pw script after given millisec.
   * This tries for retryCount times.
   *
   * When removal is successful, true is returned; false otherwise.
   * If directory containing pw script does not exist, this function returns with true.
   */
  async remove(afterMillisec: number, retryCount: number) {
    // This should be called after create()
    if (!fs.existsSync(dirname(this._pwScriptPath!))) {
      Logger.info(this._tag, 'No tmp dir was found.');
      return true;
    }

    // wait millisecond
    await new Promise(r => setTimeout(r, afterMillisec));

    const tmpDir = dirname(this._pwScriptPath!);

    fs.rmdirSync(dirname(this._pwScriptPath!), {maxRetries: retryCount, recursive: true});

    // sanity check
    if (fs.existsSync(tmpDir)) {
      Logger.warn(this._tag, 'Fail to remove tmp dir.');
      return true;
    } else {
      Logger.info(this._tag, 'tmp dir was removed.');
      return false;
    }
  }
}

export class ToolRunner {
  tag = this.constructor.name;  // logging tag

  // This variable is undefined while a prcess is not running
  private child: cp.ChildProcessWithoutNullStreams|undefined = undefined;

  // When the spawned process was killed by kill() method, set this true
  // This value must be set to false when starting a process
  private killedByMe = false;

  private handlePromise(
      resolve: (value: SuccessResult|PromiseLike<SuccessResult>) => void,
      reject: (value: ErrorResult|PromiseLike<ErrorResult>) => void,
      pwScript: TmpWriter|undefined) {
    // stdout
    this.child!.stdout.on(K_DATA, (data: any) => {
      Logger.append(data.toString());
    });
    // stderr
    this.child!.stderr.on(K_DATA, (data: any) => {
      Logger.append(data.toString());
    });

    this.child!.on(K_EXIT, (code: number|null, signal: NodeJS.Signals|null) => {
      this.child = undefined;

      // try to remove pw script when the process exits
      if (pwScript !== undefined) {
        pwScript.remove(100, 10).then((removalResult: boolean) => {
          if (removalResult === false) {
            Logger.warn(this.tag, 'Fail to remove tmp dir.');
          }
        });
      }

      // From https://nodejs.org/api/child_process.html#event-exit
      //
      // The 'exit' event is emitted after the child process ends.
      // If the process exited, code is the final exit code of the process, otherwise null.
      // If the process terminated due to receipt of a signal, signal is the string name
      // of the signal, otherwise null.
      // One of the two will always be non-null.

      // when child was terminated due to a signal
      if (code === null) {
        Logger.debug(this.tag, `Child process was killed (signal: ${signal!})`);

        if (this.killedByMe) {
          resolve({intentionallyKilled: true});
        } else {
          reject({signal: signal!});
        }
        return;
      }

      // when child exited
      Logger.info(this.tag, 'child process exited with code', code);
      if (code === 0) {
        Logger.info(this.tag, 'Build Success.');
        Logger.appendLine('');
        resolve({exitCode: 0});
      } else {
        Logger.info(this.tag, 'Build Failed:', code);
        Logger.appendLine('');
        reject({exitCode: code});
      }
    });
  }

  public isRunning(): boolean {
    if (this.child === undefined || this.child.killed || this.child.exitCode !== null) {
      // From https://nodejs.org/api/child_process.html#subprocessexitcode
      // If the child process is still running, the field will be null.
      return false;
    }
    return true;
  }

  /**
   * Function to kill child process
   */
  public kill(): boolean {
    if (this.child === undefined || this.child.killed) {
      throw Error('No process to kill');
    }

    if (this.child!.kill()) {
      this.killedByMe = true;
      Logger.info(this.tag, `Process was terminated.`);
    } else {
      Logger.error(this.tag, 'Fail to terminate process.');
    }

    return this.killedByMe;
  }

  public getOneccPath(): string|undefined {
    let oneccPath = which.sync('onecc', {nothrow: true});
    if (oneccPath === null) {
      // Use fixed installation path
      oneccPath = '/usr/share/one/bin/onecc';
    }
    Logger.info(this.tag, 'onecc path:', oneccPath);
    // check if onecc exist
    if (!fs.existsSync(oneccPath)) {
      Logger.info(this.tag, 'Failed to find onecc file');
      return undefined;
    }
    // onecc maybe symbolic link: use fs.realpathSync to convert to real path
    let oneccRealPath = fs.realpathSync(oneccPath);
    Logger.info(this.tag, 'onecc real path: ', oneccRealPath);
    // check if this onecc exist
    if (!fs.existsSync(oneccRealPath)) {
      Logger.info(this.tag, 'Failed to find onecc file');
      return undefined;
    }
    return oneccRealPath;
  }

  public getRunner(
      name: string, tool: string, toolargs: ToolArgs, cwd: string, root: boolean = false) {
    if (this.isRunning()) {
      const msg = `Error: Running: ${name}. Process is already running.`;
      Logger.error(this.tag, msg);
      throw Error(msg);
    }

    this.killedByMe = false;

    return new Promise<SuccessResult>((resolve, reject) => {
      Logger.info(this.tag, 'Running: ' + name);

      let pwScript: TmpWriter|undefined = undefined;

      if (root === true) {
        // NOTE
        // To run the root command job, it must requires a password in `process.env.userp`
        // environment.
        // TODO(jyoung): Need password encryption
        if (process.env.userp === undefined) {
          const msg = `Error: Cannot find userp`;
          Logger.error(this.tag, msg);
          throw Error(msg);
        }

        pwScript = new TmpWriter();
        pwScript.create(process.env.userp);

        try {
          // NOTE : Can we use SpawnOption.shell == True?
          // Refer to https://rules.sonarsource.com/typescript/RSPEC-4721
          const args = ['-A', tool].concat(toolargs);
          this.child = cp.spawn(
              'sudo', args, {cwd: cwd, shell: false, env: {'SUDO_ASKPASS': pwScript.path()}});
        } catch (error) {
          Logger.errorInCatch(
              this.tag,
              error,
              `Error while running ${tool}.`,
          );

        } finally {
          // Note: This function return false sometimes.
          pwScript.remove(1000, 5);
        }

      } else {
        this.child = cp.spawn(tool, toolargs, {cwd: cwd, shell: false});
      }
      this.handlePromise(resolve, reject, pwScript);
    });
  }
}
