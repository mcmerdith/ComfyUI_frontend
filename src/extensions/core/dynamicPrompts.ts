import { useExtensionService } from '@/services/extensionService'
import { processDynamicPrompt } from '@/utils/formatUtil'

// Allows for simple dynamic prompt replacement
// Inputs in the format {a|b} will have a random value of a or b chosen when the prompt is queued.

useExtensionService().registerExtension({
  name: 'Comfy.DynamicPrompts',
  nodeCreated(node) {
    if (node.widgets) {
      // Locate dynamic prompt text widgets
      // Include any widgets with dynamicPrompts set to true, and customtext
      const widgets = node.widgets.filter((w) => w.dynamicPrompts)
      for (const widget of widgets) {
        // Override the serialization of the value to resolve dynamic prompts for all widgets supporting it in this node
        // TODO: mcmerdith, are the params required?
        widget.serializeValue = (_workflowNode, _widgetIndex) => {
          if (typeof widget.value !== 'string') return widget.value

          const prompt = processDynamicPrompt(widget.value)

          console.log('serializing', _workflowNode, 'to', prompt)

          // Overwrite the value in the serialized workflow pnginfo
          // TODO: mcmerdith, does widgets_values ever have a value?
          // if (workflowNode?.widgets_values)
          //  workflowNode.widgets_values[widgetIndex] = prompt

          return prompt
        }
      }
    }
  }
})
