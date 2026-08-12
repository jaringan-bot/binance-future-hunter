// Helper buat susun output tool (markdown text + structuredContent) dengan pola
// konsisten, dipakai tool BARU (detectMmActivity, marketRegime) yang formatnya
// lebih kompleks dari tool lama (banyak section: header + beberapa signal +
// interpretasi + warning). Tool lama SENGAJA tidak di-retrofit ke sini --
// mereka sudah jalan dengan pola string-join manual, migrasi massal cuma
// nambah resiko regresi tanpa manfaat baru buat user.
export class ToolResponseBuilder {
  private sections: string[] = [];
  private structured: Record<string, unknown> = {};

  header(title: string): this {
    this.sections.push(`# ${title}`);
    return this;
  }

  subheader(title: string): this {
    this.sections.push(``, `## ${title}`);
    return this;
  }

  row(label: string, value: string): this {
    this.sections.push(`- ${label}: ${value}`);
    return this;
  }

  table(headers: string[], rows: string[][]): this {
    this.sections.push(`| ${headers.join(" | ")} |`);
    this.sections.push(`| ${headers.map(() => "---").join(" | ")} |`);
    for (const row of rows) this.sections.push(`| ${row.join(" | ")} |`);
    return this;
  }

  interpretation(label: string, text: string): this {
    this.sections.push(`**${label}**: ${text}`);
    return this;
  }

  warning(text: string): this {
    this.sections.push(`⚠️ ${text}`);
    return this;
  }

  note(text: string): this {
    this.sections.push(``, `_${text}_`);
    return this;
  }

  struct(key: string, value: unknown): this {
    this.structured[key] = value;
    return this;
  }

  build(): { content: [{ type: "text"; text: string }]; structuredContent: Record<string, unknown> } {
    return {
      content: [{ type: "text", text: this.sections.join("\n") }],
      structuredContent: this.structured,
    };
  }
}
