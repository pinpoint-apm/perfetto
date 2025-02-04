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

import {hex} from 'color-convert';
import * as m from 'mithril';

import {assertExists} from '../base/logging';
import {
  TrackGroupState,
  TrackState
} from '../common/state';

import {globals} from './globals';
import {drawGridLines} from './gridline_helper';
import {Panel, PanelSize} from './panel';
import {Track} from './track';
import {TrackContent} from './track_panel';
import {trackRegistry} from './track_registry';
import {
  drawVerticalLineAtTime,
} from './vertical_line_helper';

interface Attrs {
  trackGroupId: string;
  selectable: boolean;
}

export class TrackGroupPanel extends Panel<Attrs> {
  private readonly trackGroupId: string;
  private shellWidth = 0;
  private backgroundColor = '#ffffff';  // Updated from CSS later.
  private summaryTrack: Track;

  constructor({attrs}: m.CVnode<Attrs>) {
    super();
    this.trackGroupId = attrs.trackGroupId;
    const trackCreator = trackRegistry.get(this.summaryTrackState.kind);
    this.summaryTrack = trackCreator.create(this.summaryTrackState);
  }

  get trackGroupState(): TrackGroupState {
    return assertExists(globals.state.trackGroups[this.trackGroupId]);
  }

  get summaryTrackState(): TrackState {
    return assertExists(globals.state.tracks[this.trackGroupState.tracks[0]]);
  }

  view() {
    const collapsed = false;
    let name = this.trackGroupState.name;
    if (name[0] === '/') {
      name = StripPathFromExecutable(name);
    }

    return m(
        `.track-group-panel[collapsed=${collapsed}]`,
        {id: 'track_' + this.trackGroupId},
        this.summaryTrack ? m(TrackContent, {track: this.summaryTrack}) : null);
  }

  oncreate() {
  }

  onupdate() {
  }

  highlightIfTrackSelected(ctx: CanvasRenderingContext2D, size: PanelSize) {
    const localState = globals.frontendLocalState;
    const selection = globals.state.currentSelection;
    if (!selection || selection.kind !== 'AREA') return;
    const selectedArea = globals.state.areas[selection.areaId];
    if (selectedArea.tracks.includes(this.trackGroupId)) {
      ctx.fillStyle = 'rgba(131, 152, 230, 0.3)';
      ctx.fillRect(
          localState.timeScale.timeToPx(selectedArea.startSec) +
              this.shellWidth,
          0,
          localState.timeScale.deltaTimeToPx(
              selectedArea.endSec - selectedArea.startSec),
          size.height);
    }
  }

  renderCanvas(ctx: CanvasRenderingContext2D, size: PanelSize) {
    const collapsed = false;

    ctx.fillStyle = this.backgroundColor;
    ctx.fillRect(0, 0, size.width, size.height);

    if (!collapsed) return;

    this.highlightIfTrackSelected(ctx, size);

    drawGridLines(
        ctx,
        globals.frontendLocalState.timeScale,
        globals.frontendLocalState.visibleWindowTime,
        size.width,
        size.height);

    ctx.save();
    ctx.translate(this.shellWidth, 0);
    if (this.summaryTrack) {
      this.summaryTrack.render(ctx);
    }
    ctx.restore();

    this.highlightIfTrackSelected(ctx, size);

    const localState = globals.frontendLocalState;
    // Draw vertical line when hovering on the notes panel.
    if (localState.hoveredNoteTimestamp !== -1) {
      drawVerticalLineAtTime(
          ctx,
          localState.timeScale,
          localState.hoveredNoteTimestamp,
          size.height,
          `#aaa`);
    }
    if (localState.hoveredLogsTimestamp !== -1) {
      drawVerticalLineAtTime(
          ctx,
          localState.timeScale,
          localState.hoveredLogsTimestamp,
          size.height,
          `#344596`);
    }
    if (globals.state.currentSelection !== null) {
      if (globals.state.currentSelection.kind === 'NOTE') {
        const note = globals.state.notes[globals.state.currentSelection.id];
        if (note.noteType === 'DEFAULT') {
          drawVerticalLineAtTime(
              ctx,
              localState.timeScale,
              note.timestamp,
              size.height,
              note.color);
        }
      }
      if (globals.state.currentSelection.kind === 'SLICE' &&
          globals.sliceDetails.wakeupTs !== undefined) {
        drawVerticalLineAtTime(
            ctx,
            localState.timeScale,
            globals.sliceDetails.wakeupTs,
            size.height,
            `black`);
      }
    }
    // All marked areas should have semi-transparent vertical lines
    // marking the start and end.
    for (const note of Object.values(globals.state.notes)) {
      if (note.noteType === 'AREA') {
        const transparentNoteColor =
            'rgba(' + hex.rgb(note.color.substr(1)).toString() + ', 0.65)';
        drawVerticalLineAtTime(
            ctx,
            localState.timeScale,
            globals.state.areas[note.areaId].startSec,
            size.height,
            transparentNoteColor,
            1);
        drawVerticalLineAtTime(
            ctx,
            localState.timeScale,
            globals.state.areas[note.areaId].endSec,
            size.height,
            transparentNoteColor,
            1);
      }
    }
  }
}

function StripPathFromExecutable(path: string) {
  return path.split('/').slice(-1)[0];
}
