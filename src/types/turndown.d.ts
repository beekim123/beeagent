declare module 'turndown' {
  export interface Options {
    headingStyle?: 'setext' | 'atx';
    codeBlockStyle?: 'indented' | 'fenced';
  }

  export default class TurndownService {
    constructor(options?: Options);
    remove(filter: string | string[]): this;
    turndown(html: string): string;
  }
}
