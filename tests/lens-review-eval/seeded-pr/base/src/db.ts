type Row = Record<string, unknown>

export const db = {
  async query(sql: string, params: unknown[] = []): Promise<Row[]> {
    void sql
    void params
    return []
  },
  async insert(table: string, row: Row): Promise<void> {
    void table
    void row
  },
}
