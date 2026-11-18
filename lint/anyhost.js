const DIRECTIVE = /^\s*(@ts-|oxlint-|eslint-|\/ <reference )/
const OWNED_BY = [
  { matches: (node) => node.callee.type === 'MemberExpression' && node.callee.object.type === 'Identifier' && node.callee.object.name === 'Input' && node.callee.property.name === 'new', what: 'Input.new', owners: ['input', 'searchField'] },
  { matches: (node) => node.callee.type === 'MemberExpression' && node.callee.property.name === 'h' && node.arguments[0]?.type === 'MemberExpression' && node.arguments[0].property.name === 'row', what: 'A row height', owners: ['item', 'input', 'button'] },
]
const SIZED = new Set(['text_size', 'h', 'size', 'p', 'px', 'py', 'pl', 'pr', 'pt', 'pb', 'm', 'mx', 'my', 'mt', 'mb', 'ml', 'mr', 'gap', 'rounded', 'min_h', 'min_w'])

export default {
  meta: { name: 'anyhost' },
  rules: {
    'no-comments': {
      meta: { type: 'suggestion', docs: { description: 'Code names what it does, the tests say what it must do, and CLAUDE.md holds the facts the code cannot show, so no comment holds anything.' } },
      create(context) {
        return {
          Program() {
            for (const comment of context.sourceCode.getAllComments()) {
              if (DIRECTIVE.test(comment.value)) continue
              context.report({ loc: comment.loc, message: 'Write no comment. Name the code for what it does, test what it must do, and put a fact the code cannot show in CLAUDE.md.' })
            }
          },
        }
      },
    },
    'spawn-env': {
      meta: { type: 'problem', docs: { description: 'Bun.spawn without env gives the child the environment the process started with, Claude Code markers included, never process.env as the program cleaned it.' } },
      create(context) {
        return {
          CallExpression(node) {
            const callee = node.callee
            if (callee.type !== 'MemberExpression' || callee.object.type !== 'Identifier' || callee.object.name !== 'Bun' || !['spawn', 'spawnSync'].includes(callee.property.name)) return
            const options = node.arguments[1]
            if (options?.type === 'ObjectExpression' && options.properties.some((property) => property.type === 'Property' && property.key.name === 'env')) return
            context.report({ node, message: 'Pass env to Bun.spawn, as without it the child gets the environment this process started with, Claude Code markers included.' })
          },
        }
      },
    },
    'ui-tokens': {
      meta: { type: 'suggestion', docs: { description: 'Every text size, height, spacing and radius of the Herdr pane comes from its UI table, so the pane keeps one scale.' } },
      create(context) {
        return {
          CallExpression(node) {
            const callee = node.callee
            if (callee.type !== 'MemberExpression' || callee.property.type !== 'Identifier' || !SIZED.has(callee.property.name)) return
            const [size] = node.arguments
            if (size?.type !== 'Literal' || typeof size.value !== 'number' || size.value <= 1) return
            context.report({ node: size, message: `Take .${callee.property.name}(${size.value}) from the UI table, so the pane keeps one scale.` })
          },
        }
      },
    },
    'shared-state': {
      meta: { type: 'problem', docs: { description: 'Each copy of the Herdr pane dispatches its own input, so a shared key holds state alone and never an action another copy runs.' } },
      create(context) {
        return {
          CallExpression(node) {
            if (node.callee.type !== 'Identifier' || node.callee.name !== 'setShared') return
            const value = node.arguments[1]
            const action = value?.type === 'ObjectExpression' && value.properties.find((property) => property.type === 'Property' && ['action', 'command', 'ask'].includes(property.key.name))
            if (action) context.report({ node: action, message: `A shared key holds state, never an action: dispatch ${action.key.name} from the copy that has the input, with enqueue() or run().` })
          },
        }
      },
    },
    'ui-primitives': {
      meta: { type: 'suggestion', docs: { description: 'Each element of the Herdr pane has one implementation: every row is item(), every input input() or searchField(), every button button().' } },
      create(context) {
        const methods = []
        return {
          MethodDefinition(node) {
            methods.push(node.key.name)
          },
          'MethodDefinition:exit'() {
            methods.pop()
          },
          CallExpression(node) {
            const owned = OWNED_BY.find((rule) => rule.matches(node))
            if (owned === undefined || owned.owners.includes(methods.at(-1))) return
            context.report({ node, message: `${owned.what} is built only in ${owned.owners.map((name) => `${name}()`).join(', ')}. Call that, so the element has one implementation.` })
          },
        }
      },
    },
  },
}
