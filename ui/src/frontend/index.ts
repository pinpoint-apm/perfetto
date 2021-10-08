// Copyright (C) 2018 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import '../tracks/all_frontend';

import {applyPatches, Patch, produce} from 'immer';
import * as m from 'mithril';

import {defer} from '../base/deferred';
import {assertExists, reportError, setErrorHandler} from '../base/logging';
import {forwardRemoteCalls} from '../base/remote';
import {Actions, DeferredAction, StateActions} from '../common/actions';
import {AggregateData} from '../common/aggregation_data';
import {ConversionJobStatusUpdate} from '../common/conversion_jobs';
import {
  LogBoundsKey,
  LogEntriesKey,
  LogExists,
  LogExistsKey
} from '../common/logs';
import {MetricResult} from '../common/metric_data';
import {CurrentSearchResults, SearchSummary} from '../common/search_data';
import {createEmptyState, State} from '../common/state';
import {
  ControllerWorkerInitMessage,
  EngineWorkerInitMessage
} from '../common/worker_messages';
import {initController} from '../controller/index';

import {initCssConstants} from './css_constants';
import {maybeShowErrorDialog} from './error_dialog';
import {
  CounterDetails,
  CpuProfileDetails,
  Flow,
  globals,
  HeapProfileDetails,
  QuantizedLoad,
  SliceDetails,
  ThreadDesc,
  ThreadStateDetails
} from './globals';
import {PageAttrs} from './pages';
import {ViewerPage} from './viewer_page';

let idleWasmWorker: Worker;
let activeWasmWorker: Worker;

/**
 * The API the main thread exposes to the controller.
 */
class FrontendApi {
  private port: MessagePort;
  private state: State;

  constructor(port: MessagePort) {
    this.state = createEmptyState();
    this.port = port;
  }

  dispatchMultiple(actions: DeferredAction[]) {
    const oldState = this.state;
    const patches: Patch[] = [];
    for (const action of actions) {
      const originalLength = patches.length;
      const morePatches = this.applyAction(action);
      patches.length += morePatches.length;
      for (let i = 0; i < morePatches.length; ++i) {
        patches[i + originalLength] = morePatches[i];
      }
    }

    if (this.state === oldState) {
      return;
    }

    // Update overall state.
    globals.state = this.state;

    // If the visible time in the global state has been updated more recently
    // than the visible time handled by the frontend @ 60fps, update it. This
    // typically happens when restoring the state from a permalink.
    globals.frontendLocalState.mergeState(this.state.frontendLocalState);

    // Only redraw if something other than the frontendLocalState changed.
    for (const key in this.state) {
      if (key !== 'frontendLocalState' && key !== 'visibleTracks' &&
          oldState[key] !== this.state[key]) {
        this.redraw();
        break;
      }
    }

    if (patches.length > 0) {
      this.port.postMessage(patches);
    }
  }

  private applyAction(action: DeferredAction): Patch[] {
    const patches: Patch[] = [];

    // 'produce' creates a immer proxy which wraps the current state turning
    // all imperative mutations of the state done in the callback into
    // immutable changes to the returned state.
    this.state = produce(
        this.state,
        draft => {
          // tslint:disable-next-line no-any
          (StateActions as any)[action.type](draft, action.args);
        },
        (morePatches, _) => {
          const originalLength = patches.length;
          patches.length += morePatches.length;
          for (let i = 0; i < morePatches.length; ++i) {
            patches[i + originalLength] = morePatches[i];
          }
        });
    return patches;
  }

  patchState(patches: Patch[]) {
    const oldState = globals.state;
    globals.state = applyPatches(globals.state, patches);

    // If the visible time in the global state has been updated more recently
    // than the visible time handled by the frontend @ 60fps, update it. This
    // typically happens when restoring the state from a permalink.
    globals.frontendLocalState.mergeState(globals.state.frontendLocalState);

    // Only redraw if something other than the frontendLocalState changed.
    for (const key in globals.state) {
      if (key !== 'frontendLocalState' && key !== 'visibleTracks' &&
          oldState[key] !== globals.state[key]) {
        this.redraw();
        return;
      }
    }
  }

  // TODO: we can't have a publish method for each batch of data that we don't
  // want to keep in the global state. Figure out a more generic and type-safe
  // mechanism to achieve this.

  publishOverviewData(data: {[key: string]: QuantizedLoad|QuantizedLoad[]}) {
    for (const [key, value] of Object.entries(data)) {
      if (!globals.overviewStore.has(key)) {
        globals.overviewStore.set(key, []);
      }
      if (value instanceof Array) {
        globals.overviewStore.get(key)!.push(...value);
      } else {
        globals.overviewStore.get(key)!.push(value);
      }
    }
    globals.rafScheduler.scheduleRedraw();
  }

  publishTrackData(args: {id: string, data: {}}) {
    globals.setTrackData(args.id, args.data);
    if ([LogExistsKey, LogBoundsKey, LogEntriesKey].includes(args.id)) {
      const data = globals.trackDataStore.get(LogExistsKey) as LogExists;
      if (data && data.exists) globals.rafScheduler.scheduleFullRedraw();
    } else {
      globals.rafScheduler.scheduleRedraw();
    }
  }

  publishQueryResult(args: {id: string, data: {}}) {
    globals.queryResults.set(args.id, args.data);
    this.redraw();
  }

  publishThreads(data: ThreadDesc[]) {
    globals.threads.clear();
    data.forEach(thread => {
      globals.threads.set(thread.utid, thread);
    });
    this.redraw();
  }

  publishSliceDetails(click: SliceDetails) {
    globals.sliceDetails = click;
    this.redraw();
  }

  publishThreadStateDetails(click: ThreadStateDetails) {
    globals.threadStateDetails = click;
    this.redraw();
  }

  publishConnectedFlows(connectedFlows: Flow[]) {
    globals.connectedFlows = connectedFlows;
    // Call resetFlowFocus() each time connectedFlows is updated to correctly
    // navigate using hotkeys.
    this.resetFlowFocus();
    this.redraw();
  }

  // If a chrome slice is selected and we have any flows in connectedFlows
  // we will find the flows on the right and left of that slice to set a default
  // focus. In all other cases the focusedFlowId(Left|Right) will be set to -1.
  resetFlowFocus() {
    globals.frontendLocalState.focusedFlowIdLeft = -1;
    globals.frontendLocalState.focusedFlowIdRight = -1;
    if (globals.state.currentSelection?.kind === 'CHROME_SLICE') {
      const sliceId = globals.state.currentSelection.id;
      for (const flow of globals.connectedFlows) {
        if (flow.begin.sliceId === sliceId) {
          globals.frontendLocalState.focusedFlowIdRight = flow.id;
        }
        if (flow.end.sliceId === sliceId) {
          globals.frontendLocalState.focusedFlowIdLeft = flow.id;
        }
      }
    }
  }

  publishSelectedFlows(selectedFlows: Flow[]) {
    globals.selectedFlows = selectedFlows;
    this.redraw();
  }

  publishCounterDetails(click: CounterDetails) {
    globals.counterDetails = click;
    this.redraw();
  }

  publishHeapProfileDetails(click: HeapProfileDetails) {
    globals.heapProfileDetails = click;
    this.redraw();
  }

  publishCpuProfileDetails(details: CpuProfileDetails) {
    globals.cpuProfileDetails = details;
    this.redraw();
  }

  publishHasFtrace(hasFtrace: boolean) {
    globals.hasFtrace = hasFtrace;
    this.redraw();
  }

  publishConversionJobStatusUpdate(job: ConversionJobStatusUpdate) {
    globals.setConversionJobStatus(job.jobName, job.jobStatus);
    this.redraw();
  }

  publishLoading(numQueuedQueries: number) {
    globals.numQueuedQueries = numQueuedQueries;
    // TODO(hjd): Clean up loadingAnimation given that this now causes a full
    // redraw anyways. Also this should probably just go via the global state.
    globals.rafScheduler.scheduleFullRedraw();
  }

  publishBufferUsage(args: {percentage: number}) {
    globals.setBufferUsage(args.percentage);
    this.redraw();
  }

  publishSearch(args: SearchSummary) {
    globals.searchSummary = args;
    this.redraw();
  }

  publishSearchResult(args: CurrentSearchResults) {
    globals.currentSearchResults = args;
    this.redraw();
  }

  publishRecordingLog(args: {logs: string}) {
    globals.setRecordingLog(args.logs);
    this.redraw();
  }

  publishTraceErrors(numErrors: number) {
    globals.setTraceErrors(numErrors);
    this.redraw();
  }

  publishMetricError(error: string) {
    globals.setMetricError(error);
    globals.logging.logError(error, false);
    this.redraw();
  }

  publishMetricResult(metricResult: MetricResult) {
    globals.setMetricResult(metricResult);
    this.redraw();
  }

  publishAggregateData(args: {data: AggregateData, kind: string}) {
    globals.setAggregateData(args.kind, args.data);
    this.redraw();
  }

  // This method is called by the controller via the Remote<> interface whenver
  // a new trace is loaded. This creates a new worker and passes it the
  // MessagePort received by the controller. This is because on Safari, all
  // workers must be spawned from the main thread.
  resetEngineWorker(port: MessagePort) {
    // We keep always an idle worker around, the first one is created by the
    // main() below, so we can hide the latency of the Wasm initialization.
    if (activeWasmWorker !== undefined) {
      activeWasmWorker.terminate();
    }
    // Swap the active worker with the idle one and create a new idle worker
    // for the next trace.
    activeWasmWorker = assertExists(idleWasmWorker);
    const msg: EngineWorkerInitMessage = {enginePort: port};
    activeWasmWorker.postMessage(msg, [port]);
    idleWasmWorker = new Worker(globals.root + 'engine_bundle.js');
  }

  private redraw(): void {
    globals.rafScheduler.scheduleFullRedraw();
  }
}

function main() {
  const dataSource = document.getElementById('timeline_data_source');
  const mainDiv = document.getElementById('timeline_main');

  if (!dataSource || !mainDiv) {
    console.log('Necessary components \'timeline_data_source \' and \'timeline_main\' are not found.');
    return;
  }

  // Load the css. The load is asynchronous and the CSS is not ready by the time
  // appenChild returns.
  const cssLoadPromise = defer<void>();
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = globals.root + 'perfetto.css';
  css.onload = () => cssLoadPromise.resolve();
  css.onerror = (err) => cssLoadPromise.reject(err);
  document.head.append(css);

  // Add Error handlers for JS error and for uncaught exceptions in promises.
  setErrorHandler((err: string) => maybeShowErrorDialog(err));
  window.addEventListener('error', e => reportError(e));
  window.addEventListener('unhandledrejection', e => reportError(e));

  idleWasmWorker = new Worker(globals.root + 'engine_bundle.js');
  const frontendChannel = new MessageChannel();
  const controllerChannel = new MessageChannel();
  const extensionLocalChannel = new MessageChannel();
  const errorReportingChannel = new MessageChannel();

  errorReportingChannel.port2.onmessage = (e) =>
      maybeShowErrorDialog(`${e.data}`);

  const msg: ControllerWorkerInitMessage = {
    frontendPort: frontendChannel.port1,
    controllerPort: controllerChannel.port1,
    extensionPort: extensionLocalChannel.port1,
    errorReportingPort: errorReportingChannel.port1,
  };

  initController(msg);

  const dispatch = (action: DeferredAction) => {
    frontendApi.dispatchMultiple([action]);
  };

  globals.initialize(dispatch);
  globals.serviceWorkerController.install();

  const routes = new Map<string, m.Component<PageAttrs>>();
  routes.set('/', ViewerPage);
  routes.set('/viewer', ViewerPage);
  const frontendApi = new FrontendApi(controllerChannel.port2);
  forwardRemoteCalls(frontendChannel.port2, frontendApi);

  // Put these variables in the global scope for better debugging.
  (window as {} as {m: {}}).m = m;
  (window as {} as {globals: {}}).globals = globals;
  (window as {} as {Actions: {}}).Actions = Actions;

  // Prevent pinch zoom.
  document.body.addEventListener('wheel', (e: MouseEvent) => {
    if (e.ctrlKey) e.preventDefault();
  }, {passive: false});

  const url = document.getElementById('timeline_data_source')!.innerHTML;
  cssLoadPromise.then(() => onCssLoaded(url));
  globals.state.route="/viewer";
}

function onCssLoaded(url: string) {
  initCssConstants();

  const main = assertExists(document.getElementById('timeline_main'));

  m.render(main, m(ViewerPage));

  globals.rafScheduler.domRedraw = () => {
    m.render(main, m(ViewerPage));
  };

  globals.logging.logEvent('Trace Actions', 'Open example trace');
  globals.frontendLocalState.localOnlyMode = false;
  globals.dispatch(Actions.openTraceFromUrl({ url }));
}

main();
