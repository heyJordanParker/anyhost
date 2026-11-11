const DIRECTIVE = /^\s*(@ts-|oxlint-|eslint-|\/ <reference )/

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
  },
}
