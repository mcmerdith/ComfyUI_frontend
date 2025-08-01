import {
  LGraph,
  LGraphCanvas,
  LGraphEventMode,
  LGraphNode,
  LiteGraph
} from '@comfyorg/litegraph'
import type { Vector2 } from '@comfyorg/litegraph'
import type { IBaseWidget } from '@comfyorg/litegraph/dist/types/widgets'
import _ from 'lodash'
import type { ToastMessageOptions } from 'primevue/toast'
import { reactive } from 'vue'

import { useCanvasPositionConversion } from '@/composables/element/useCanvasPositionConversion'
import { useWorkflowValidation } from '@/composables/useWorkflowValidation'
import { st, t } from '@/i18n'
import type {
  ExecutionErrorWsMessage,
  NodeError,
  ResultItem
} from '@/schemas/apiSchema'
import {
  ComfyApiWorkflow,
  type ComfyWorkflowJSON,
  type ModelFile,
  type NodeId
} from '@/schemas/comfyWorkflowSchema'
import {
  type ComfyNodeDef as ComfyNodeDefV1,
  isComboInputSpecV1,
  isComboInputSpecV2
} from '@/schemas/nodeDefSchema'
import { getFromWebmFile } from '@/scripts/metadata/ebml'
import { getGltfBinaryMetadata } from '@/scripts/metadata/gltf'
import { getFromIsobmffFile } from '@/scripts/metadata/isobmff'
import { getMp3Metadata } from '@/scripts/metadata/mp3'
import { getOggMetadata } from '@/scripts/metadata/ogg'
import { getSvgMetadata } from '@/scripts/metadata/svg'
import { useDialogService } from '@/services/dialogService'
import { useExtensionService } from '@/services/extensionService'
import { useLitegraphService } from '@/services/litegraphService'
import { useSubgraphService } from '@/services/subgraphService'
import { useWorkflowService } from '@/services/workflowService'
import { useApiKeyAuthStore } from '@/stores/apiKeyAuthStore'
import { useCommandStore } from '@/stores/commandStore'
import { useDomWidgetStore } from '@/stores/domWidgetStore'
import { useExecutionStore } from '@/stores/executionStore'
import { useExtensionStore } from '@/stores/extensionStore'
import { useFirebaseAuthStore } from '@/stores/firebaseAuthStore'
import { useNodeOutputStore } from '@/stores/imagePreviewStore'
import { KeyComboImpl, useKeybindingStore } from '@/stores/keybindingStore'
import { useModelStore } from '@/stores/modelStore'
import { SYSTEM_NODE_DEFS, useNodeDefStore } from '@/stores/nodeDefStore'
import { useSettingStore } from '@/stores/settingStore'
import { useToastStore } from '@/stores/toastStore'
import { useWidgetStore } from '@/stores/widgetStore'
import { ComfyWorkflow } from '@/stores/workflowStore'
import { useColorPaletteStore } from '@/stores/workspace/colorPaletteStore'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import type { ComfyExtension, MissingNodeType } from '@/types/comfy'
import { ExtensionManager } from '@/types/extensionTypes'
import { ColorAdjustOptions, adjustColor } from '@/utils/colorUtil'
import { graphToPrompt } from '@/utils/executionUtil'
import {
  getNodeByExecutionId,
  triggerCallbackOnAllNodes
} from '@/utils/graphTraversalUtil'
import {
  executeWidgetsCallback,
  fixLinkInputSlots,
  isImageNode
} from '@/utils/litegraphUtil'
import {
  findLegacyRerouteNodes,
  noNativeReroutes
} from '@/utils/migration/migrateReroute'
import { getSelectedModelsMetadata } from '@/utils/modelMetadataUtil'
import { deserialiseAndCreate } from '@/utils/vintageClipboard'

import { type ComfyApi, PromptExecutionError, api } from './api'
import { defaultGraph } from './defaultGraph'
import {
  getAvifMetadata,
  getFlacMetadata,
  getLatentMetadata,
  getPngMetadata,
  getWebpMetadata,
  importA1111
} from './pnginfo'
import { $el, ComfyUI } from './ui'
import { ComfyAppMenu } from './ui/menu/index'
import { clone } from './utils'
import { type ComfyWidgetConstructor } from './widgets'

export const ANIM_PREVIEW_WIDGET = '$$comfy_animation_preview'

function sanitizeNodeName(string: string) {
  let entityMap = {
    '&': '',
    '<': '',
    '>': '',
    '"': '',
    "'": '',
    '`': '',
    '=': ''
  }
  return String(string).replace(/[&<>"'`=]/g, function fromEntityMap(s) {
    return entityMap[s as keyof typeof entityMap]
  })
}

type Clipspace = {
  widgets?: Pick<IBaseWidget, 'type' | 'name' | 'value'>[] | null
  imgs?: HTMLImageElement[] | null
  original_imgs?: HTMLImageElement[] | null
  images?: any[] | null
  selectedIndex: number
  img_paste_mode: string
  paintedIndex: number
  combinedIndex: number
}

export class ComfyApp {
  /**
   * List of entries to queue
   */
  #queueItems: {
    number: number
    batchCount: number
    queueNodeIds?: NodeId[]
  }[] = []
  /**
   * If the queue is currently being processed
   */
  #processingQueue: boolean = false

  /**
   * Content Clipboard
   * @type {serialized node object}
   */
  static clipspace: Clipspace | null = null
  static clipspace_invalidate_handler: (() => void) | null = null
  static open_maskeditor: (() => void) | null = null
  static maskeditor_is_opended: (() => void) | null = null
  static clipspace_return_node = null

  vueAppReady: boolean
  api: ComfyApi
  ui: ComfyUI
  // @ts-expect-error fixme ts strict error
  extensionManager: ExtensionManager
  // @ts-expect-error fixme ts strict error
  _nodeOutputs: Record<string, any>
  nodePreviewImages: Record<string, string[]>
  // @ts-expect-error fixme ts strict error
  #graph: LGraph
  get graph() {
    return this.#graph
  }
  // @ts-expect-error fixme ts strict error
  canvas: LGraphCanvas
  dragOverNode: LGraphNode | null = null
  // @ts-expect-error fixme ts strict error
  canvasEl: HTMLCanvasElement

  #configuringGraphLevel: number = 0
  get configuringGraph() {
    return this.#configuringGraphLevel > 0
  }
  // @ts-expect-error fixme ts strict error
  ctx: CanvasRenderingContext2D
  bodyTop: HTMLElement
  bodyLeft: HTMLElement
  bodyRight: HTMLElement
  bodyBottom: HTMLElement
  canvasContainer: HTMLElement
  menu: ComfyAppMenu
  bypassBgColor: string
  // Set by Comfy.Clipspace extension
  openClipspace: () => void = () => {}

  #positionConversion?: {
    clientPosToCanvasPos: (pos: Vector2) => Vector2
    canvasPosToClientPos: (pos: Vector2) => Vector2
  }

  /**
   * The node errors from the previous execution.
   * @deprecated Use useExecutionStore().lastNodeErrors instead
   */
  get lastNodeErrors(): Record<NodeId, NodeError> | null {
    return useExecutionStore().lastNodeErrors
  }

  /**
   * The error from the previous execution.
   * @deprecated Use useExecutionStore().lastExecutionError instead
   */
  get lastExecutionError(): ExecutionErrorWsMessage | null {
    return useExecutionStore().lastExecutionError
  }

  /**
   * @deprecated Use useExecutionStore().executingNodeId instead
   * TODO: Update to support multiple executing nodes. This getter returns only the first executing node.
   * Consider updating consumers to handle multiple nodes or use executingNodeIds array.
   */
  get runningNodeId(): NodeId | null {
    return useExecutionStore().executingNodeId
  }

  /**
   * @deprecated Use useWorkspaceStore().shiftDown instead
   */
  get shiftDown(): boolean {
    return useWorkspaceStore().shiftDown
  }

  /**
   * @deprecated Use useWidgetStore().widgets instead
   */
  get widgets(): Record<string, ComfyWidgetConstructor> {
    return Object.fromEntries(useWidgetStore().widgets.entries())
  }

  /**
   * @deprecated storageLocation is always 'server' since
   * https://github.com/comfyanonymous/ComfyUI/commit/53c8a99e6c00b5e20425100f6680cd9ea2652218
   */
  get storageLocation() {
    return 'server'
  }

  /**
   * @deprecated storage migration is no longer needed.
   */
  get isNewUserSession() {
    return false
  }

  /**
   * @deprecated Use useExtensionStore().extensions instead
   */
  get extensions(): ComfyExtension[] {
    return useExtensionStore().extensions
  }

  /**
   * The progress on the current executing node, if the node reports any.
   * @deprecated Use useExecutionStore().executingNodeProgress instead
   */
  get progress() {
    return useExecutionStore()._executingNodeProgress
  }

  /**
   * @deprecated Use {@link isImageNode} from @/utils/litegraphUtil instead
   */
  static isImageNode(node: LGraphNode) {
    return isImageNode(node)
  }

  /**
   * Resets the canvas view to the default
   * @deprecated Use {@link useLitegraphService().resetView} instead
   */
  resetView() {
    useLitegraphService().resetView()
  }

  constructor() {
    this.vueAppReady = false
    this.ui = new ComfyUI(this)
    this.api = api
    // Dummy placeholder elements before GraphCanvas is mounted.
    this.bodyTop = $el('div.comfyui-body-top')
    this.bodyLeft = $el('div.comfyui-body-left')
    this.bodyRight = $el('div.comfyui-body-right')
    this.bodyBottom = $el('div.comfyui-body-bottom')
    this.canvasContainer = $el('div.graph-canvas-container')

    this.menu = new ComfyAppMenu(this)
    this.bypassBgColor = '#FF00FF'

    /**
     * Stores the execution output data for each node
     * @type {Record<string, any>}
     */
    this.nodeOutputs = {}

    /**
     * Stores the preview image data for each node
     * @type {Record<string, Image>}
     */
    this.nodePreviewImages = {}
  }

  get nodeOutputs() {
    return this._nodeOutputs
  }

  set nodeOutputs(value) {
    this._nodeOutputs = value
    if (this.vueAppReady)
      useExtensionService().invokeExtensions('onNodeOutputsUpdated', value)
  }

  /**
   * If the user has specified a preferred format to receive preview images in,
   * this function will return that format as a url query param.
   * If the node's outputs are not images, this param should not be used, as it will
   * force the server to load the output file as an image.
   */
  getPreviewFormatParam() {
    let preview_format = useSettingStore().get('Comfy.PreviewFormat')
    if (preview_format) return `&preview=${preview_format}`
    else return ''
  }

  getRandParam() {
    return '&rand=' + Math.random()
  }

  static onClipspaceEditorSave() {
    if (ComfyApp.clipspace_return_node) {
      ComfyApp.pasteFromClipspace(ComfyApp.clipspace_return_node)
    }
  }

  static onClipspaceEditorClosed() {
    ComfyApp.clipspace_return_node = null
  }

  static copyToClipspace(node: LGraphNode) {
    var widgets = null
    if (node.widgets) {
      widgets = node.widgets.map(({ type, name, value }) => ({
        type,
        name,
        value
      }))
    }

    var imgs = undefined
    var orig_imgs = undefined
    if (node.imgs != undefined) {
      imgs = []
      orig_imgs = []

      for (let i = 0; i < node.imgs.length; i++) {
        imgs[i] = new Image()
        imgs[i].src = node.imgs[i].src
        orig_imgs[i] = imgs[i]
      }
    }

    var selectedIndex = 0
    if (node.imageIndex) {
      selectedIndex = node.imageIndex
    }

    const paintedIndex = selectedIndex + 1
    const combinedIndex = selectedIndex + 2

    ComfyApp.clipspace = {
      widgets: widgets,
      imgs: imgs,
      original_imgs: orig_imgs,
      images: node.images,
      selectedIndex: selectedIndex,
      img_paste_mode: 'selected', // reset to default im_paste_mode state on copy action
      paintedIndex: paintedIndex,
      combinedIndex: combinedIndex
    }

    ComfyApp.clipspace_return_node = null

    if (ComfyApp.clipspace_invalidate_handler) {
      ComfyApp.clipspace_invalidate_handler()
    }
  }

  static pasteFromClipspace(node: LGraphNode) {
    if (ComfyApp.clipspace) {
      // image paste
      const combinedImgSrc =
        ComfyApp.clipspace.imgs?.[ComfyApp.clipspace.combinedIndex].src
      if (ComfyApp.clipspace.imgs && node.imgs) {
        if (node.images && ComfyApp.clipspace.images) {
          if (ComfyApp.clipspace['img_paste_mode'] == 'selected') {
            node.images = [
              ComfyApp.clipspace.images[ComfyApp.clipspace['selectedIndex']]
            ]
          } else {
            node.images = ComfyApp.clipspace.images
          }

          if (app.nodeOutputs[node.id + ''])
            app.nodeOutputs[node.id + ''].images = node.images
        }

        if (ComfyApp.clipspace.imgs) {
          // deep-copy to cut link with clipspace
          if (ComfyApp.clipspace['img_paste_mode'] == 'selected') {
            const img = new Image()
            img.src =
              ComfyApp.clipspace.imgs[ComfyApp.clipspace['selectedIndex']].src
            node.imgs = [img]
            node.imageIndex = 0
          } else {
            const imgs = []
            for (let i = 0; i < ComfyApp.clipspace.imgs.length; i++) {
              imgs[i] = new Image()
              imgs[i].src = ComfyApp.clipspace.imgs[i].src
              node.imgs = imgs
            }
          }
        }
      }

      // Paste the RGB canvas if paintedindex exists
      if (
        ComfyApp.clipspace.imgs?.[ComfyApp.clipspace.paintedIndex] &&
        node.imgs
      ) {
        const paintedImg = new Image()
        paintedImg.src =
          ComfyApp.clipspace.imgs[ComfyApp.clipspace.paintedIndex].src
        node.imgs.push(paintedImg) // Add the RGB canvas to the node's images
      }

      // Store only combined image inside the node if it exists
      if (
        ComfyApp.clipspace.imgs?.[ComfyApp.clipspace.combinedIndex] &&
        node.imgs &&
        combinedImgSrc
      ) {
        const combinedImg = new Image()
        combinedImg.src = combinedImgSrc
        node.imgs = [combinedImg]
      }

      if (node.widgets) {
        if (ComfyApp.clipspace.images) {
          const clip_image =
            ComfyApp.clipspace.images[ComfyApp.clipspace['selectedIndex']]
          const index = node.widgets.findIndex((obj) => obj.name === 'image')
          if (index >= 0) {
            if (
              node.widgets[index].type != 'image' &&
              typeof node.widgets[index].value == 'string' &&
              clip_image.filename
            ) {
              node.widgets[index].value =
                (clip_image.subfolder ? clip_image.subfolder + '/' : '') +
                clip_image.filename +
                (clip_image.type ? ` [${clip_image.type}]` : '')
            } else {
              node.widgets[index].value = clip_image
            }
          }
        }
        if (ComfyApp.clipspace.widgets) {
          ComfyApp.clipspace.widgets.forEach(({ type, name, value }) => {
            // @ts-expect-error fixme ts strict error
            const prop = Object.values(node.widgets).find(
              (obj) => obj.type === type && obj.name === name
            )
            if (prop && prop.type != 'button') {
              if (
                prop.type != 'image' &&
                typeof prop.value == 'string' &&
                // @ts-expect-error Custom widget value
                value.filename
              ) {
                const resultItem = value as ResultItem
                prop.value =
                  (resultItem.subfolder ? resultItem.subfolder + '/' : '') +
                  resultItem.filename +
                  (resultItem.type ? ` [${resultItem.type}]` : '')
              } else {
                prop.value = value
                prop.callback?.(value)
              }
            }
          })
        }
      }

      app.graph.setDirtyCanvas(true)
    }
  }

  /**
   * Adds a handler allowing drag+drop of files onto the window to load workflows
   */
  #addDropHandler() {
    // Get prompt from dropped PNG or json
    document.addEventListener('drop', async (event) => {
      try {
        event.preventDefault()
        event.stopPropagation()

        const n = this.dragOverNode
        this.dragOverNode = null
        // Node handles file drop, we dont use the built in onDropFile handler as its buggy
        // If you drag multiple files it will call it multiple times with the same file
        if (n && n.onDragDrop && (await n.onDragDrop(event))) {
          return
        }
        // Dragging from Chrome->Firefox there is a file but its a bmp, so ignore that
        if (!event.dataTransfer) return
        if (
          event.dataTransfer.files.length &&
          event.dataTransfer.files[0].type !== 'image/bmp'
        ) {
          await this.handleFile(event.dataTransfer.files[0])
        } else {
          // Try loading the first URI in the transfer list
          const validTypes = ['text/uri-list', 'text/x-moz-url']
          const match = [...event.dataTransfer.types].find((t) =>
            validTypes.find((v) => t === v)
          )
          if (match) {
            const uri = event.dataTransfer.getData(match)?.split('\n')?.[0]
            if (uri) {
              const blob = await (await fetch(uri)).blob()
              await this.handleFile(new File([blob], uri, { type: blob.type }))
            }
          }
        }
      } catch (err: any) {
        useToastStore().addAlert(
          t('toastMessages.dropFileError', { error: err })
        )
      }
    })

    // Always clear over node on drag leave
    this.canvasEl.addEventListener('dragleave', async () => {
      if (this.dragOverNode) {
        this.dragOverNode = null
        this.graph.setDirtyCanvas(false, true)
      }
    })

    // Add handler for dropping onto a specific node
    this.canvasEl.addEventListener(
      'dragover',
      (e) => {
        this.canvas.adjustMouseEvent(e)
        const node = this.graph.getNodeOnPos(e.canvasX, e.canvasY)
        if (node) {
          if (node.onDragOver && node.onDragOver(e)) {
            this.dragOverNode = node

            // dragover event is fired very frequently, run this on an animation frame
            requestAnimationFrame(() => {
              this.graph.setDirtyCanvas(false, true)
            })
            return
          }
        }
        this.dragOverNode = null
      },
      false
    )
  }

  /**
   * Handle keypress
   */
  #addProcessKeyHandler() {
    const origProcessKey = LGraphCanvas.prototype.processKey
    LGraphCanvas.prototype.processKey = function (e: KeyboardEvent) {
      if (!this.graph) return

      if (e.target instanceof Element && e.target.localName == 'input') {
        return
      }

      if (e.type == 'keydown' && !e.repeat) {
        const keyCombo = KeyComboImpl.fromEvent(e)
        const keybindingStore = useKeybindingStore()
        const keybinding = keybindingStore.getKeybinding(keyCombo)

        if (keybinding && keybinding.targetElementId === 'graph-canvas') {
          useCommandStore().execute(keybinding.commandId)

          this.graph.change()
          e.preventDefault()
          e.stopImmediatePropagation()
          return
        }

        // Ctrl+C Copy
        if (e.key === 'c' && (e.metaKey || e.ctrlKey)) {
          return
        }

        // Ctrl+V Paste
        if (
          (e.key === 'v' || e.key == 'V') &&
          (e.metaKey || e.ctrlKey) &&
          !e.shiftKey
        ) {
          return
        }
      }

      // Fall through to Litegraph defaults
      // @ts-expect-error fixme ts strict error
      return origProcessKey.apply(this, arguments)
    }
  }

  #addDrawNodeHandler() {
    const origDrawNode = LGraphCanvas.prototype.drawNode
    LGraphCanvas.prototype.drawNode = function (node) {
      const editor_alpha = this.editor_alpha
      const old_color = node.color
      const old_bgcolor = node.bgcolor

      if (node.mode === LGraphEventMode.NEVER) {
        this.editor_alpha = 0.4
      }

      let bgColor: string
      if (node.mode === LGraphEventMode.BYPASS) {
        bgColor = app.bypassBgColor
        this.editor_alpha = 0.2
      } else {
        bgColor = old_bgcolor || LiteGraph.NODE_DEFAULT_BGCOLOR
      }

      const adjustments: ColorAdjustOptions = {}

      const opacity = useSettingStore().get('Comfy.Node.Opacity')
      if (opacity) adjustments.opacity = opacity

      if (useColorPaletteStore().completedActivePalette.light_theme) {
        adjustments.lightness = 0.5

        // Lighten title bar of colored nodes on light theme
        if (old_color) {
          node.color = adjustColor(old_color, { lightness: 0.5 })
        }
      }

      node.bgcolor = adjustColor(bgColor, adjustments)

      // @ts-expect-error fixme ts strict error
      const res = origDrawNode.apply(this, arguments)

      this.editor_alpha = editor_alpha
      node.color = old_color
      node.bgcolor = old_bgcolor

      return res
    }
  }

  /**
   * Handles updates from the API socket
   */
  #addApiUpdateHandlers() {
    api.addEventListener('status', ({ detail }) => {
      this.ui.setStatus(detail)
    })

    api.addEventListener('progress', () => {
      this.graph.setDirtyCanvas(true, false)
    })

    api.addEventListener('executing', () => {
      this.graph.setDirtyCanvas(true, false)
    })

    api.addEventListener('executed', ({ detail }) => {
      const nodeOutputStore = useNodeOutputStore()
      const executionId = String(detail.display_node || detail.node)

      nodeOutputStore.setNodeOutputsByExecutionId(executionId, detail.output, {
        merge: detail.merge
      })

      const node = getNodeByExecutionId(this.graph, executionId)
      if (node && node.onExecuted) {
        node.onExecuted(detail.output)
      }
    })

    api.addEventListener('execution_start', () => {
      triggerCallbackOnAllNodes(this.graph, 'onExecutionStart')
    })

    api.addEventListener('execution_error', ({ detail }) => {
      // Check if this is an auth-related error or credits-related error
      if (
        detail.exception_message?.includes(
          'Unauthorized: Please login first to use this node.'
        )
      ) {
        useDialogService().showApiNodesSignInDialog([detail.node_type])
      } else if (
        detail.exception_message?.includes(
          'Payment Required: Please add credits to your account to use this node.'
        )
      ) {
        useDialogService().showTopUpCreditsDialog({
          isInsufficientCredits: true
        })
      } else {
        useDialogService().showExecutionErrorDialog(detail)
      }
      this.canvas.draw(true, true)
    })

    api.addEventListener('b_preview_with_metadata', ({ detail }) => {
      // Enhanced preview with explicit node context
      const { blob, displayNodeId } = detail
      const { setNodePreviewsByExecutionId, revokePreviewsByExecutionId } =
        useNodeOutputStore()
      // Ensure clean up if `executing` event is missed.
      revokePreviewsByExecutionId(displayNodeId)
      const blobUrl = URL.createObjectURL(blob)
      // Preview cleanup is handled in progress_state event to support multiple concurrent previews
      setNodePreviewsByExecutionId(displayNodeId, [blobUrl])
    })

    api.init()
  }

  /** Flag that the graph is configuring to prevent nodes from running checks while its still loading */
  #addConfigureHandler() {
    const app = this
    const configure = LGraph.prototype.configure
    LGraph.prototype.configure = function (...args) {
      app.#configuringGraphLevel++
      try {
        return configure.apply(this, args)
      } finally {
        app.#configuringGraphLevel--
      }
    }
  }

  #addAfterConfigureHandler() {
    const { graph } = this
    const { onConfigure } = graph
    graph.onConfigure = function (...args) {
      fixLinkInputSlots(this)

      // Fire callbacks before the onConfigure, this is used by widget inputs to setup the config
      triggerCallbackOnAllNodes(this, 'onGraphConfigured')

      const r = onConfigure?.apply(this, args)

      // Fire after onConfigure, used by primitives to generate widget using input nodes config
      triggerCallbackOnAllNodes(this, 'onAfterGraphConfigured')

      return r
    }
  }

  /**
   * Set up the app on the page
   */
  async setup(canvasEl: HTMLCanvasElement) {
    // @ts-expect-error fixme ts strict error
    this.bodyTop = document.getElementById('comfyui-body-top')
    // @ts-expect-error fixme ts strict error
    this.bodyLeft = document.getElementById('comfyui-body-left')
    // @ts-expect-error fixme ts strict error
    this.bodyRight = document.getElementById('comfyui-body-right')
    // @ts-expect-error fixme ts strict error
    this.bodyBottom = document.getElementById('comfyui-body-bottom')
    // @ts-expect-error fixme ts strict error
    this.canvasContainer = document.getElementById('graph-canvas-container')

    this.canvasEl = canvasEl
    this.resizeCanvas()

    await useWorkspaceStore().workflow.syncWorkflows()
    await useExtensionService().loadExtensions()

    this.#addProcessKeyHandler()
    this.#addConfigureHandler()
    this.#addApiUpdateHandlers()

    this.#graph = new LGraph()

    // Register the subgraph - adds type wrapper for Litegraph's `createNode` factory
    this.graph.events.addEventListener('subgraph-created', (e) => {
      try {
        const { subgraph, data } = e.detail
        useSubgraphService().registerNewSubgraph(subgraph, data)
      } catch (err) {
        console.error('Failed to register subgraph', err)
        useToastStore().add({
          severity: 'error',
          summary: 'Failed to register subgraph',
          detail: err instanceof Error ? err.message : String(err)
        })
      }
    })

    this.#addAfterConfigureHandler()

    this.canvas = new LGraphCanvas(canvasEl, this.graph)
    // Make canvas states reactive so we can observe changes on them.
    this.canvas.state = reactive(this.canvas.state)

    // @ts-expect-error fixme ts strict error
    this.ctx = canvasEl.getContext('2d')

    LiteGraph.alt_drag_do_clone_nodes = true
    LiteGraph.macGesturesRequireMac = false

    this.canvas.canvas.addEventListener<'litegraph:set-graph'>(
      'litegraph:set-graph',
      (e) => {
        // Assertion: Not yet defined in litegraph.
        const { newGraph } = e.detail

        const nodeSet = new Set(newGraph.nodes)
        const widgetStore = useDomWidgetStore()

        // Assertions: UnwrapRef
        for (const { widget } of widgetStore.activeWidgetStates) {
          if (!nodeSet.has(widget.node)) {
            widgetStore.deactivateWidget(widget.id)
          }
        }

        for (const { widget } of widgetStore.inactiveWidgetStates) {
          if (nodeSet.has(widget.node)) {
            widgetStore.activateWidget(widget.id)
          }
        }
      }
    )

    this.graph.start()

    // Ensure the canvas fills the window
    this.resizeCanvas()
    window.addEventListener('resize', () => this.resizeCanvas())
    const ro = new ResizeObserver(() => this.resizeCanvas())
    ro.observe(this.bodyTop)
    ro.observe(this.bodyLeft)
    ro.observe(this.bodyRight)
    ro.observe(this.bodyBottom)

    await useExtensionService().invokeExtensionsAsync('init')
    await this.registerNodes()

    this.#addDrawNodeHandler()
    this.#addDropHandler()

    await useExtensionService().invokeExtensionsAsync('setup')

    this.#positionConversion = useCanvasPositionConversion(
      this.canvasContainer,
      this.canvas
    )
  }

  resizeCanvas() {
    // Limit minimal scale to 1, see https://github.com/comfyanonymous/ComfyUI/pull/845
    const scale = Math.max(window.devicePixelRatio, 1)

    // Clear fixed width and height while calculating rect so it uses 100% instead
    this.canvasEl.height = this.canvasEl.width = NaN
    const { width, height } = this.canvasEl.getBoundingClientRect()
    this.canvasEl.width = Math.round(width * scale)
    this.canvasEl.height = Math.round(height * scale)
    // @ts-expect-error fixme ts strict error
    this.canvasEl.getContext('2d').scale(scale, scale)
    this.canvas?.draw(true, true)
  }

  private updateVueAppNodeDefs(defs: Record<string, ComfyNodeDefV1>) {
    // Frontend only nodes registered by custom nodes.
    // Example: https://github.com/rgthree/rgthree-comfy/blob/dd534e5384be8cf0c0fa35865afe2126ba75ac55/src_web/comfyui/fast_groups_bypasser.ts#L10

    // Only create frontend_only definitions for nodes that don't have backend definitions
    const frontendOnlyDefs: Record<string, ComfyNodeDefV1> = {}
    for (const [name, node] of Object.entries(
      LiteGraph.registered_node_types
    )) {
      // Skip if we already have a backend definition or system definition
      if (name in defs || name in SYSTEM_NODE_DEFS) {
        continue
      }

      frontendOnlyDefs[name] = {
        name,
        display_name: name,
        category: node.category || '__frontend_only__',
        input: { required: {}, optional: {} },
        output: [],
        output_name: [],
        output_is_list: [],
        output_node: false,
        python_module: 'custom_nodes.frontend_only',
        description: `Frontend only node for ${name}`
      } as ComfyNodeDefV1
    }

    const allNodeDefs = {
      ...frontendOnlyDefs,
      ...defs,
      ...SYSTEM_NODE_DEFS
    }

    const nodeDefStore = useNodeDefStore()
    const nodeDefArray: ComfyNodeDefV1[] = Object.values(allNodeDefs)
    useExtensionService().invokeExtensions(
      'beforeRegisterVueAppNodeDefs',
      nodeDefArray,
      this
    )
    nodeDefStore.updateNodeDefs(nodeDefArray)
  }

  async #getNodeDefs(): Promise<Record<string, ComfyNodeDefV1>> {
    const translateNodeDef = (def: ComfyNodeDefV1): ComfyNodeDefV1 => ({
      ...def,
      display_name: st(
        `nodeDefs.${def.name}.display_name`,
        def.display_name ?? def.name
      ),
      description: def.description
        ? st(`nodeDefs.${def.name}.description`, def.description)
        : '',
      category: def.category
        .split('/')
        .map((category: string) => st(`nodeCategories.${category}`, category))
        .join('/')
    })

    return _.mapValues(await api.getNodeDefs(), (def) => translateNodeDef(def))
  }

  /**
   * Registers nodes with the graph
   */
  async registerNodes() {
    // Load node definitions from the backend
    const defs = await this.#getNodeDefs()
    await this.registerNodesFromDefs(defs)
    await useExtensionService().invokeExtensionsAsync('registerCustomNodes')
    if (this.vueAppReady) {
      this.updateVueAppNodeDefs(defs)
    }
  }

  async registerNodeDef(nodeId: string, nodeDef: ComfyNodeDefV1) {
    return await useLitegraphService().registerNodeDef(nodeId, nodeDef)
  }

  async registerNodesFromDefs(defs: Record<string, ComfyNodeDefV1>) {
    await useExtensionService().invokeExtensionsAsync('addCustomNodeDefs', defs)

    // Register a node for each definition
    for (const nodeId in defs) {
      this.registerNodeDef(nodeId, defs[nodeId])
    }
  }

  // @ts-expect-error fixme ts strict error
  loadTemplateData(templateData) {
    if (!templateData?.templates) {
      return
    }

    const old = localStorage.getItem('litegrapheditor_clipboard')

    var maxY, nodeBottom, node

    for (const template of templateData.templates) {
      if (!template?.data) {
        continue
      }

      // Check for old clipboard format
      const data = JSON.parse(template.data)
      if (!data.reroutes) {
        deserialiseAndCreate(template.data, app.canvas)
      } else {
        localStorage.setItem('litegrapheditor_clipboard', template.data)
        app.canvas.pasteFromClipboard()
      }

      // Move mouse position down to paste the next template below

      maxY = false

      for (const i in app.canvas.selected_nodes) {
        node = app.canvas.selected_nodes[i]

        nodeBottom = node.pos[1] + node.size[1]

        // @ts-expect-error fixme ts strict error
        if (maxY === false || nodeBottom > maxY) {
          maxY = nodeBottom
        }
      }

      // @ts-expect-error fixme ts strict error
      app.canvas.graph_mouse[1] = maxY + 50
    }

    // @ts-expect-error fixme ts strict error
    localStorage.setItem('litegrapheditor_clipboard', old)
  }

  #showMissingNodesError(missingNodeTypes: MissingNodeType[]) {
    if (useSettingStore().get('Comfy.Workflow.ShowMissingNodesWarning')) {
      useDialogService().showLoadWorkflowWarning({ missingNodeTypes })
    }
  }

  // @ts-expect-error fixme ts strict error
  #showMissingModelsError(missingModels, paths) {
    if (useSettingStore().get('Comfy.Workflow.ShowMissingModelsWarning')) {
      useDialogService().showMissingModelsWarning({
        missingModels,
        paths
      })
    }
  }

  async loadGraphData(
    graphData?: ComfyWorkflowJSON,
    clean: boolean = true,
    restore_view: boolean = true,
    workflow: string | null | ComfyWorkflow = null,
    {
      showMissingNodesDialog = true,
      showMissingModelsDialog = true,
      checkForRerouteMigration = false
    } = {}
  ) {
    if (clean !== false) {
      this.clean()
    }

    let reset_invalid_values = false
    if (!graphData) {
      graphData = defaultGraph
      reset_invalid_values = true
    }

    graphData = clone(graphData)

    if (useSettingStore().get('Comfy.Validation.Workflows')) {
      const { graphData: validatedGraphData } =
        await useWorkflowValidation().validateWorkflow(graphData)

      // If the validation failed, use the original graph data.
      // Ideally we should not block users from loading the workflow.
      graphData = validatedGraphData ?? graphData
    }
    // Only show the reroute migration warning if the workflow does not have native
    // reroutes. Merging reroute network has great complexity, and it is not supported
    // for now.
    // See: https://github.com/Comfy-Org/ComfyUI_frontend/issues/3317
    if (
      checkForRerouteMigration &&
      graphData.version === 0.4 &&
      findLegacyRerouteNodes(graphData).length &&
      noNativeReroutes(graphData)
    ) {
      useToastStore().add({
        group: 'reroute-migration',
        severity: 'warn'
      })
    }
    useWorkflowService().beforeLoadNewGraph()
    useSubgraphService().loadSubgraphs(graphData)

    const missingNodeTypes: MissingNodeType[] = []
    const missingModels: ModelFile[] = []
    await useExtensionService().invokeExtensionsAsync(
      'beforeConfigureGraph',
      graphData,
      missingNodeTypes
    )

    const embeddedModels: ModelFile[] = []

    for (let n of graphData.nodes) {
      // Patch T2IAdapterLoader to ControlNetLoader since they are the same node now
      if (n.type == 'T2IAdapterLoader') n.type = 'ControlNetLoader'
      if (n.type == 'ConditioningAverage ') n.type = 'ConditioningAverage' //typo fix
      if (n.type == 'SDV_img2vid_Conditioning')
        n.type = 'SVD_img2vid_Conditioning' //typo fix

      // Find missing node types
      if (!(n.type in LiteGraph.registered_node_types)) {
        missingNodeTypes.push(n.type)
        n.type = sanitizeNodeName(n.type)
      }

      // Collect models metadata from node
      const selectedModels = getSelectedModelsMetadata(n)
      if (selectedModels?.length) {
        embeddedModels.push(...selectedModels)
      }
    }

    // Merge models from the workflow's root-level 'models' field
    const workflowSchemaV1Models = graphData.models
    if (workflowSchemaV1Models?.length)
      embeddedModels.push(...workflowSchemaV1Models)

    const getModelKey = (model: ModelFile) => model.url || model.hash
    const validModels = embeddedModels.filter(getModelKey)
    const uniqueModels = _.uniqBy(validModels, getModelKey)

    if (
      uniqueModels.length &&
      useSettingStore().get('Comfy.Workflow.ShowMissingModelsWarning')
    ) {
      const modelStore = useModelStore()
      await modelStore.loadModelFolders()
      for (const m of uniqueModels) {
        const modelFolder = await modelStore.getLoadedModelFolder(m.directory)
        // @ts-expect-error
        if (!modelFolder) m.directory_invalid = true

        const modelsAvailable = modelFolder?.models
        const modelExists =
          modelsAvailable &&
          Object.values(modelsAvailable).some(
            (model) => model.file_name === m.name
          )
        if (!modelExists) missingModels.push(m)
      }
    }

    try {
      // @ts-expect-error Discrepancies between zod and litegraph - in progress
      this.graph.configure(graphData)
      if (
        restore_view &&
        useSettingStore().get('Comfy.EnableWorkflowViewRestore')
      ) {
        if (graphData.extra?.ds) {
          this.canvas.ds.offset = graphData.extra.ds.offset
          this.canvas.ds.scale = graphData.extra.ds.scale
        } else {
          // @note: Set view after the graph has been rendered once. fitView uses
          // boundingRect on nodes to calculate the view bounds, which only become
          // available after the first render.
          requestAnimationFrame(() => {
            useLitegraphService().fitView()
          })
        }
      }
    } catch (error) {
      useDialogService().showErrorDialog(error, {
        title: t('errorDialog.loadWorkflowTitle'),
        reportType: 'loadWorkflowError'
      })
      console.error(error)
      return
    }
    for (const node of this.graph.nodes) {
      const size = node.computeSize()
      size[0] = Math.max(node.size[0], size[0])
      size[1] = Math.max(node.size[1], size[1])
      node.setSize(size)
      if (node.widgets) {
        // If you break something in the backend and want to patch workflows in the frontend
        // This is the place to do this
        for (let widget of node.widgets) {
          if (node.type == 'KSampler' || node.type == 'KSamplerAdvanced') {
            if (widget.name == 'sampler_name') {
              if (
                typeof widget.value === 'string' &&
                widget.value.startsWith('sample_')
              ) {
                widget.value = widget.value.slice(7)
              }
            }
          }
          if (
            node.type == 'KSampler' ||
            node.type == 'KSamplerAdvanced' ||
            node.type == 'PrimitiveNode'
          ) {
            if (widget.name == 'control_after_generate') {
              if (widget.value === true) {
                widget.value = 'randomize'
              } else if (widget.value === false) {
                widget.value = 'fixed'
              }
            }
          }
          if (reset_invalid_values) {
            if (widget.type == 'combo') {
              if (
                // @ts-expect-error fixme ts strict error
                !widget.options.values.includes(widget.value as string) &&
                // @ts-expect-error fixme ts strict error
                widget.options.values.length > 0
              ) {
                // @ts-expect-error fixme ts strict error
                widget.value = widget.options.values[0]
              }
            }
          }
        }
      }

      useExtensionService().invokeExtensions('loadedGraphNode', node)
    }

    if (missingNodeTypes.length && showMissingNodesDialog) {
      this.#showMissingNodesError(missingNodeTypes)
    }
    if (missingModels.length && showMissingModelsDialog) {
      const paths = await api.getFolderPaths()
      this.#showMissingModelsError(missingModels, paths)
    }
    await useExtensionService().invokeExtensionsAsync(
      'afterConfigureGraph',
      missingNodeTypes
    )
    await useWorkflowService().afterLoadNewGraph(
      workflow,
      this.graph.serialize() as unknown as ComfyWorkflowJSON
    )
    requestAnimationFrame(() => {
      this.graph.setDirtyCanvas(true, true)
    })
  }

  async graphToPrompt(
    graph = this.graph,
    options: { queueNodeIds?: NodeId[] } = {}
  ) {
    return graphToPrompt(graph, {
      sortNodes: useSettingStore().get('Comfy.Workflow.SortNodeIdOnSave'),
      queueNodeIds: options.queueNodeIds
    })
  }

  async queuePrompt(
    number: number,
    batchCount: number = 1,
    queueNodeIds?: NodeId[]
  ): Promise<boolean> {
    this.#queueItems.push({ number, batchCount, queueNodeIds })

    // Only have one action process the items so each one gets a unique seed correctly
    if (this.#processingQueue) {
      return false
    }

    this.#processingQueue = true
    const executionStore = useExecutionStore()
    executionStore.lastNodeErrors = null

    let comfyOrgAuthToken =
      (await useFirebaseAuthStore().getIdToken()) ?? undefined
    let comfyOrgApiKey = useApiKeyAuthStore().getApiKey()

    try {
      while (this.#queueItems.length) {
        const { number, batchCount, queueNodeIds } = this.#queueItems.pop()!

        for (let i = 0; i < batchCount; i++) {
          // Allow widgets to run callbacks before a prompt has been queued
          // e.g. random seed before every gen
          executeWidgetsCallback(this.graph.nodes, 'beforeQueued')
          for (const subgraph of this.graph.subgraphs.values()) {
            executeWidgetsCallback(subgraph.nodes, 'beforeQueued')
          }

          const p = await this.graphToPrompt(this.graph, { queueNodeIds })
          try {
            api.authToken = comfyOrgAuthToken
            api.apiKey = comfyOrgApiKey ?? undefined
            const res = await api.queuePrompt(number, p)
            delete api.authToken
            delete api.apiKey
            executionStore.lastNodeErrors = res.node_errors ?? null
            if (executionStore.lastNodeErrors?.length) {
              this.canvas.draw(true, true)
            } else {
              try {
                if (res.prompt_id) {
                  executionStore.storePrompt({
                    id: res.prompt_id,
                    nodes: Object.keys(p.output),
                    workflow: useWorkspaceStore().workflow
                      .activeWorkflow as ComfyWorkflow
                  })
                }
              } catch (error) {}
            }
          } catch (error: unknown) {
            useDialogService().showErrorDialog(error, {
              title: t('errorDialog.promptExecutionError'),
              reportType: 'promptExecutionError'
            })
            console.error(error)

            if (error instanceof PromptExecutionError) {
              executionStore.lastNodeErrors = error.response.node_errors ?? null
              this.canvas.draw(true, true)
            }
            break
          }

          // Allow widgets to run callbacks after a prompt has been queued
          // e.g. random seed after every gen
          executeWidgetsCallback(
            p.workflow.nodes
              .map((n) => this.graph.getNodeById(n.id))
              .filter((n) => !!n),
            'afterQueued'
          )
          for (const subgraph of this.graph.subgraphs.values()) {
            executeWidgetsCallback(subgraph.nodes, 'afterQueued')
          }

          this.canvas.draw(true, true)
          await this.ui.queue.update()
        }
      }
    } finally {
      this.#processingQueue = false
    }
    api.dispatchCustomEvent('promptQueued', { number, batchCount })
    return !executionStore.lastNodeErrors
  }

  showErrorOnFileLoad(file: File) {
    useToastStore().addAlert(
      t('toastMessages.fileLoadError', { fileName: file.name })
    )
  }

  /**
   * Loads workflow data from the specified file
   * @param {File} file
   */
  async handleFile(file: File) {
    const removeExt = (f: string) => {
      if (!f) return f
      const p = f.lastIndexOf('.')
      if (p === -1) return f
      return f.substring(0, p)
    }
    const fileName = removeExt(file.name)
    if (file.type === 'image/png') {
      const pngInfo = await getPngMetadata(file)
      if (pngInfo?.workflow) {
        await this.loadGraphData(
          JSON.parse(pngInfo.workflow),
          true,
          true,
          fileName
        )
      } else if (pngInfo?.prompt) {
        this.loadApiJson(JSON.parse(pngInfo.prompt), fileName)
      } else if (pngInfo?.parameters) {
        // Note: Not putting this in `importA1111` as it is mostly not used
        // by external callers, and `importA1111` has no access to `app`.
        useWorkflowService().beforeLoadNewGraph()
        importA1111(this.graph, pngInfo.parameters)
        useWorkflowService().afterLoadNewGraph(
          fileName,
          this.graph.serialize() as unknown as ComfyWorkflowJSON
        )
      } else {
        this.showErrorOnFileLoad(file)
      }
    } else if (file.type === 'image/avif') {
      const { workflow, prompt } = await getAvifMetadata(file)

      if (workflow) {
        this.loadGraphData(JSON.parse(workflow), true, true, fileName)
      } else if (prompt) {
        this.loadApiJson(JSON.parse(prompt), fileName)
      } else {
        this.showErrorOnFileLoad(file)
      }
    } else if (file.type === 'image/webp') {
      const pngInfo = await getWebpMetadata(file)
      // Support loading workflows from that webp custom node.
      const workflow = pngInfo?.workflow || pngInfo?.Workflow
      const prompt = pngInfo?.prompt || pngInfo?.Prompt

      if (workflow) {
        this.loadGraphData(JSON.parse(workflow), true, true, fileName)
      } else if (prompt) {
        this.loadApiJson(JSON.parse(prompt), fileName)
      } else {
        this.showErrorOnFileLoad(file)
      }
    } else if (file.type === 'audio/mpeg') {
      const { workflow, prompt } = await getMp3Metadata(file)
      if (workflow) {
        this.loadGraphData(workflow, true, true, fileName)
      } else if (prompt) {
        this.loadApiJson(prompt, fileName)
      } else {
        this.showErrorOnFileLoad(file)
      }
    } else if (file.type === 'audio/ogg') {
      const { workflow, prompt } = await getOggMetadata(file)
      if (workflow) {
        this.loadGraphData(workflow, true, true, fileName)
      } else if (prompt) {
        this.loadApiJson(prompt, fileName)
      } else {
        this.showErrorOnFileLoad(file)
      }
    } else if (file.type === 'audio/flac' || file.type === 'audio/x-flac') {
      const pngInfo = await getFlacMetadata(file)
      const workflow = pngInfo?.workflow || pngInfo?.Workflow
      const prompt = pngInfo?.prompt || pngInfo?.Prompt

      if (workflow) {
        this.loadGraphData(JSON.parse(workflow), true, true, fileName)
      } else if (prompt) {
        this.loadApiJson(JSON.parse(prompt), fileName)
      } else {
        this.showErrorOnFileLoad(file)
      }
    } else if (file.type === 'video/webm') {
      const webmInfo = await getFromWebmFile(file)
      if (webmInfo.workflow) {
        this.loadGraphData(webmInfo.workflow, true, true, fileName)
      } else if (webmInfo.prompt) {
        this.loadApiJson(webmInfo.prompt, fileName)
      } else {
        this.showErrorOnFileLoad(file)
      }
    } else if (
      file.type === 'video/mp4' ||
      file.name?.endsWith('.mp4') ||
      file.name?.endsWith('.mov') ||
      file.name?.endsWith('.m4v') ||
      file.type === 'video/quicktime' ||
      file.type === 'video/x-m4v'
    ) {
      const mp4Info = await getFromIsobmffFile(file)
      if (mp4Info.workflow) {
        this.loadGraphData(mp4Info.workflow, true, true, fileName)
      } else if (mp4Info.prompt) {
        this.loadApiJson(mp4Info.prompt, fileName)
      }
    } else if (file.type === 'image/svg+xml' || file.name?.endsWith('.svg')) {
      const svgInfo = await getSvgMetadata(file)
      if (svgInfo.workflow) {
        this.loadGraphData(svgInfo.workflow, true, true, fileName)
      } else if (svgInfo.prompt) {
        this.loadApiJson(svgInfo.prompt, fileName)
      } else {
        this.showErrorOnFileLoad(file)
      }
    } else if (
      file.type === 'model/gltf-binary' ||
      file.name?.endsWith('.glb')
    ) {
      const gltfInfo = await getGltfBinaryMetadata(file)
      if (gltfInfo.workflow) {
        this.loadGraphData(gltfInfo.workflow, true, true, fileName)
      } else if (gltfInfo.prompt) {
        this.loadApiJson(gltfInfo.prompt, fileName)
      } else {
        this.showErrorOnFileLoad(file)
      }
    } else if (
      file.type === 'application/json' ||
      file.name?.endsWith('.json')
    ) {
      const reader = new FileReader()
      reader.onload = async () => {
        const readerResult = reader.result as string
        const jsonContent = JSON.parse(readerResult)
        if (jsonContent?.templates) {
          this.loadTemplateData(jsonContent)
        } else if (this.isApiJson(jsonContent)) {
          this.loadApiJson(jsonContent, fileName)
        } else {
          await this.loadGraphData(
            JSON.parse(readerResult),
            true,
            true,
            fileName
          )
        }
      }
      reader.readAsText(file)
    } else if (
      file.name?.endsWith('.latent') ||
      file.name?.endsWith('.safetensors')
    ) {
      const info = await getLatentMetadata(file)
      // TODO define schema to LatentMetadata
      // @ts-expect-error
      if (info.workflow) {
        await this.loadGraphData(
          // @ts-expect-error
          JSON.parse(info.workflow),
          true,
          true,
          fileName
        )
        // @ts-expect-error
      } else if (info.prompt) {
        // @ts-expect-error
        this.loadApiJson(JSON.parse(info.prompt))
      } else {
        this.showErrorOnFileLoad(file)
      }
    } else {
      this.showErrorOnFileLoad(file)
    }
  }

  isApiJson(data: unknown) {
    return _.isObject(data) && Object.values(data).every((v) => v.class_type)
  }

  loadApiJson(apiData: ComfyApiWorkflow, fileName: string) {
    useWorkflowService().beforeLoadNewGraph()

    const missingNodeTypes = Object.values(apiData).filter(
      (n) => !LiteGraph.registered_node_types[n.class_type]
    )
    if (missingNodeTypes.length) {
      this.#showMissingNodesError(missingNodeTypes.map((t) => t.class_type))
      return
    }

    const ids = Object.keys(apiData)
    app.graph.clear()
    for (const id of ids) {
      const data = apiData[id]
      const node = LiteGraph.createNode(data.class_type)
      if (!node) continue
      node.id = isNaN(+id) ? id : +id
      node.title = data._meta?.title ?? node.title
      app.graph.add(node)
    }

    for (const id of ids) {
      const data = apiData[id]
      const node = app.graph.getNodeById(id)
      for (const input in data.inputs ?? {}) {
        const value = data.inputs[input]
        if (value instanceof Array) {
          const [fromId, fromSlot] = value
          const fromNode = app.graph.getNodeById(fromId)
          // @ts-expect-error fixme ts strict error
          let toSlot = node.inputs?.findIndex((inp) => inp.name === input)
          if (toSlot == null || toSlot === -1) {
            try {
              // Target has no matching input, most likely a converted widget
              // @ts-expect-error fixme ts strict error
              const widget = node.widgets?.find((w) => w.name === input)
              // @ts-expect-error
              if (widget && node.convertWidgetToInput?.(widget)) {
                // @ts-expect-error fixme ts strict error
                toSlot = node.inputs?.length - 1
              }
            } catch (error) {}
          }
          if (toSlot != null || toSlot !== -1) {
            // @ts-expect-error fixme ts strict error
            fromNode.connect(fromSlot, node, toSlot)
          }
        } else {
          // @ts-expect-error fixme ts strict error
          const widget = node.widgets?.find((w) => w.name === input)
          if (widget) {
            widget.value = value
            widget.callback?.(value)
          }
        }
      }
    }
    app.graph.arrange()

    for (const id of ids) {
      const data = apiData[id]
      const node = app.graph.getNodeById(id)
      for (const input in data.inputs ?? {}) {
        const value = data.inputs[input]
        if (value instanceof Array) {
          const [fromId, fromSlot] = value
          const fromNode = app.graph.getNodeById(fromId)
          // @ts-expect-error fixme ts strict error
          let toSlot = node.inputs?.findIndex((inp) => inp.name === input)
          if (toSlot == null || toSlot === -1) {
            try {
              // Target has no matching input, most likely a converted widget
              // @ts-expect-error fixme ts strict error
              const widget = node.widgets?.find((w) => w.name === input)
              // @ts-expect-error
              if (widget && node.convertWidgetToInput?.(widget)) {
                // @ts-expect-error fixme ts strict error
                toSlot = node.inputs?.length - 1
              }
            } catch (error) {}
          }
          if (toSlot != null || toSlot !== -1) {
            // @ts-expect-error fixme ts strict error
            fromNode.connect(fromSlot, node, toSlot)
          }
        } else {
          // @ts-expect-error fixme ts strict error
          const widget = node.widgets?.find((w) => w.name === input)
          if (widget) {
            widget.value = value
            widget.callback?.(value)
          }
        }
      }
    }

    app.graph.arrange()

    useWorkflowService().afterLoadNewGraph(
      fileName,
      this.graph.serialize() as unknown as ComfyWorkflowJSON
    )
  }

  /**
   * Registers a Comfy web extension with the app
   * @param {ComfyExtension} extension
   */
  registerExtension(extension: ComfyExtension) {
    useExtensionService().registerExtension(extension)
  }

  /**
   * Refresh combo list on whole nodes
   */
  async refreshComboInNodes() {
    const requestToastMessage: ToastMessageOptions = {
      severity: 'info',
      summary: t('g.update'),
      detail: t('toastMessages.updateRequested')
    }
    if (this.vueAppReady) {
      useToastStore().add(requestToastMessage)
    }

    const defs = await this.#getNodeDefs()
    for (const nodeId in defs) {
      this.registerNodeDef(nodeId, defs[nodeId])
    }
    for (const node of this.graph.nodes) {
      const def = defs[node.type]
      // Allow primitive nodes to handle refresh
      node.refreshComboInNode?.(defs)

      if (!def?.input) continue

      if (node.widgets) {
        const nodeInputs = def.input
        for (const widget of node.widgets) {
          if (widget.type === 'combo') {
            let inputType: 'required' | 'optional' | undefined
            if (nodeInputs.required?.[widget.name] !== undefined) {
              inputType = 'required'
            } else if (nodeInputs.optional?.[widget.name] !== undefined) {
              inputType = 'optional'
            }
            if (inputType !== undefined) {
              // Get the input spec associated with the widget
              const inputSpec = nodeInputs[inputType]?.[widget.name]
              if (inputSpec) {
                // Refresh the combo widget's options with the values from the input spec
                if (isComboInputSpecV2(inputSpec)) {
                  widget.options.values = inputSpec[1]?.options
                } else if (isComboInputSpecV1(inputSpec)) {
                  widget.options.values = inputSpec[0]
                }
              }
            }
          }
        }
      }
    }

    await useExtensionService().invokeExtensionsAsync(
      'refreshComboInNodes',
      defs
    )

    if (this.vueAppReady) {
      this.updateVueAppNodeDefs(defs)
      useToastStore().remove(requestToastMessage)
      useToastStore().add({
        severity: 'success',
        summary: t('g.updated'),
        detail: t('toastMessages.nodeDefinitionsUpdated'),
        life: 1000
      })
    }
  }

  /**
   * Clean current state
   */
  clean() {
    this.nodeOutputs = {}
    const { revokeAllPreviews } = useNodeOutputStore()
    revokeAllPreviews()
    const executionStore = useExecutionStore()
    executionStore.lastNodeErrors = null
    executionStore.lastExecutionError = null

    useDomWidgetStore().clear()
  }

  clientPosToCanvasPos(pos: Vector2): Vector2 {
    if (!this.#positionConversion) {
      throw new Error('clientPosToCanvasPos called before setup')
    }
    return this.#positionConversion.clientPosToCanvasPos(pos)
  }

  canvasPosToClientPos(pos: Vector2): Vector2 {
    if (!this.#positionConversion) {
      throw new Error('canvasPosToClientPos called before setup')
    }
    return this.#positionConversion.canvasPosToClientPos(pos)
  }
}

export const app = new ComfyApp()
