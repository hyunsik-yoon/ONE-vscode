/*
 * Copyright (c) 2022 Samsung Electronics Co., Ltd. All Rights Reserved
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

import * as fs from 'fs';
import * as vscode from 'vscode';

import {Balloon} from '../Utils/Balloon';
import {getNonce} from '../Utils/external/Nonce';

export class MessageDefs {
  // message command
  public static readonly alert = 'alert';
  public static readonly request = 'request';
  public static readonly response = 'response';
  public static readonly loadmodel = 'loadmodel';
  public static readonly selection = 'selection';
  public static readonly error = 'error';
  // loadmodel type
  public static readonly modelpath = 'modelpath';
  public static readonly uint8array = 'uint8array';
  // selection
  public static readonly names = 'names';
  public static readonly tensors = 'tensors';
};


export class CircleGraphCtrl {
  // TODO make this protected
  public static readonly folderMediaCircleGraph = 'media/CircleGraph';
  protected static readonly folderMediaCircleGraphExt = 'media/CircleGraph/external';
  protected static readonly folderExternal = 'external/';

  protected readonly _extensionUri: vscode.Uri;
  protected readonly _webview: vscode.Webview;
  protected _modelToLoad: string;
  protected _modelLength: number;

  private _ctrlDisposables: vscode.Disposable[] = [];

  public constructor(extensionUri: vscode.Uri, webView: vscode.Webview, modelToLoad: string) {
    this._extensionUri = extensionUri;
    this._webview = webView;
    this._modelToLoad = modelToLoad;
    this._modelLength = 0;
  }

  public initGraphCtrl() {
    this.registerEventHandlers();
  }

  public disposeGraphCtrl() {
    while (this._ctrlDisposables.length) {
      const x = this._ctrlDisposables.pop();
      if (x) {
        x.dispose();
      }
    }
  }

  private registerEventHandlers() {
    // Handle messages from the webview
    this._webview.onDidReceiveMessage(message => {
      switch (message.command) {
        case MessageDefs.alert:
          Balloon.error(message.text);
          return;
        case MessageDefs.request:
          this.handleRequest(message.url, message.encoding);
          return;
        case MessageDefs.loadmodel:
          this.handleLoadModel(parseInt(message.offset));  // to number
          return;
      }
    }, null, this._ctrlDisposables);
  }

  /**
   * @brief handleRequest will handle 'request()' from webview for local resource
   *        through message channel
   * @param url URL of the local resource file
   * @param encoding encoding of load local resource file
   */
  protected handleRequest(url: string, encoding: string) {
    // TODO check scheme
    const reqUrl = new URL(url);
    let filePath = vscode.Uri.joinPath(
        this._extensionUri, CircleGraphCtrl.folderMediaCircleGraph, reqUrl.pathname);
    if (!fs.existsSync(filePath.fsPath)) {
      filePath = vscode.Uri.joinPath(
          this._extensionUri, CircleGraphCtrl.folderMediaCircleGraphExt, reqUrl.pathname);
    }

    try {
      const fileData = fs.readFileSync(filePath.fsPath, {encoding: encoding, flag: 'r'});
      this._webview.postMessage({command: MessageDefs.response, response: fileData});
    } catch (err) {
      this._webview.postMessage({command: MessageDefs.error, response: ''});
    }
  }

  /**
   * @brief handleLoadModel will respond with 'loadmodel' message from WebView
   * @param offset offset of file WebView requested
   * @note  'offset' will start with 0 and then with offset of the model file
   */
  protected handleLoadModel(offset: number) {
    // TODO make this faster
    const sendPacketSize = 1024 * 1024 * 10;  // 10MB

    if (offset === 0) {
      // TODO add request for model path with separate command
      this.sendModelPath();

      try {
        const stats = fs.statSync(this._modelToLoad);
        this._modelLength = stats.size;

        if (this._modelLength <= sendPacketSize) {
          this.sendModelSingle();
        } else {
          this.sendModelMulti(sendPacketSize, offset);
        }
      } catch (err: unknown) {
        this.handleLoadError(err);
      }
    } else {
      const nextPacketSize = Math.min(this._modelLength - offset, sendPacketSize);
      try {
        this.sendModelMulti(nextPacketSize, offset);
      } catch (err: unknown) {
        this.handleLoadError(err);
      }
    }
  }

  private sendModelPath() {
    this._webview.postMessage(
        {command: MessageDefs.loadmodel, type: MessageDefs.modelpath, value: this._modelToLoad});
  }

  /**
   * @brief sendModelSingle will send model to WebView with single postMessage
   */
  private sendModelSingle() {
    const buffer = fs.readFileSync(this._modelToLoad);
    const modelData = new Uint8Array(buffer);
    this._webview.postMessage({
      command: MessageDefs.loadmodel,
      type: MessageDefs.uint8array,
      offset: 0,
      length: this._modelLength,
      total: this._modelLength,
      responseArray: modelData
    });
  }

  /**
   * @brief sendModelMulti will send model to WebView with multiple postMessage
   * @param packetSize size of packet in bytes to send with one postMessage
   * @param offset     position of the file where to begin with
   */
  private sendModelMulti(packetSize: number, offset: number) {
    fs.open(this._modelToLoad, 'r', (err, fd) => {
      if (err) {
        this._webview.postMessage(
            {command: MessageDefs.loadmodel, type: MessageDefs.error, responseErr: err.message});
        Balloon.error(err.message);
        return;
      }
      const buffer = Buffer.alloc(packetSize);
      fs.readSync(fd, buffer, 0, packetSize, offset);
      const modelData = new Uint8Array(buffer);

      this._webview.postMessage({
        command: MessageDefs.loadmodel,
        type: MessageDefs.uint8array,
        offset: offset,
        length: packetSize,
        total: this._modelLength,
        responseArray: modelData
      });
      fs.close(fd, (err) => {});
    });
  }

  private handleLoadError(err: unknown) {
    this._webview.postMessage({
      command: MessageDefs.loadmodel,
      type: MessageDefs.error,
    });
    if (err instanceof Error) {
      Balloon.error(err.message);
    } else {
      Balloon.error('Failed to load model');
    }
  }

  public getHtmlForWebview(webview: vscode.Webview) {
    const htmlPath = this.getMediaPath('index.html');
    let html = fs.readFileSync(htmlPath.fsPath, {encoding: 'utf-8'});

    const nonce = getNonce();
    html = html.replace(/\%nonce%/gi, nonce);
    html = html.replace('%webview.cspSource%', webview.cspSource);
    // necessary files from netron to work
    html = this.updateExternalUri(html, webview, '%view-grapher.css%', 'view-grapher.css');
    html = this.updateExternalUri(html, webview, '%view-sidebar.css%', 'view-sidebar.css');
    html = this.updateExternalUri(html, webview, '%view-sidebar.js%', 'view-sidebar.js');
    html = this.updateExternalUri(html, webview, '%view-grapher.js%', 'view-grapher.js');
    html = this.updateExternalUri(html, webview, '%dagre.js%', 'dagre.js');
    html = this.updateExternalUri(html, webview, '%base.js%', 'base.js');
    html = this.updateExternalUri(html, webview, '%text.js%', 'text.js');
    html = this.updateExternalUri(html, webview, '%json.js%', 'json.js');
    html = this.updateExternalUri(html, webview, '%xml.js%', 'xml.js');
    html = this.updateExternalUri(html, webview, '%python.js%', 'python.js');
    html = this.updateExternalUri(html, webview, '%protobuf.js%', 'protobuf.js');
    html = this.updateExternalUri(html, webview, '%flatbuffers.js%', 'flatbuffers.js');
    html = this.updateExternalUri(html, webview, '%flexbuffers.js%', 'flexbuffers.js');
    html = this.updateExternalUri(html, webview, '%zip.js%', 'zip.js');
    html = this.updateExternalUri(html, webview, '%gzip.js%', 'gzip.js');
    html = this.updateExternalUri(html, webview, '%tar.js%', 'tar.js');
    // for circle format
    html = this.updateExternalUri(html, webview, '%circle.js%', 'circle.js');
    html = this.updateExternalUri(html, webview, '%circle-schema.js%', 'circle-schema.js');
    // modified for one-vscode
    html = this.updateUri(html, webview, '%index.js%', 'index.js');
    html = this.updateUri(html, webview, '%view.js%', 'view.js');

    return html;
  }

  private getMediaPath(file: string) {
    return vscode.Uri.joinPath(this._extensionUri, CircleGraphCtrl.folderMediaCircleGraph, file);
  }

  private updateExternalUri(
      html: string, webview: vscode.Webview, search: string, replace: string) {
    const replaceUri = this.getUriFromPath(webview, CircleGraphCtrl.folderExternal + replace);
    return html.replace(search, `${replaceUri}`);
  }

  private updateUri(html: string, webview: vscode.Webview, search: string, replace: string) {
    const replaceUri = this.getUriFromPath(webview, replace);
    return html.replace(search, `${replaceUri}`);
  }

  private getUriFromPath(webview: vscode.Webview, file: string) {
    const mediaPath = this.getMediaPath(file);
    const uriView = webview.asWebviewUri(mediaPath);
    return uriView;
  }

  public static getWebviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions
      &vscode.WebviewPanelOptions {
    return {
      // Enable javascript in the webview
      enableScripts: true,
      // And restrict the webview to only loading content from our extension's
      // 'media/CircleGraph' directory.
      localResourceRoots:
          [vscode.Uri.joinPath(extensionUri, CircleGraphCtrl.folderMediaCircleGraph)],

      // to prevent view to reload after loosing focus
      retainContextWhenHidden: true
    };
  }
};