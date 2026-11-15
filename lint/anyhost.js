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
