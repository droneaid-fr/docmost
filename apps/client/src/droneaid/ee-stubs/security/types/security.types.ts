// Core expects: IAuthProvider, the { id, name, type } entries of the workspace's public data.
export interface IAuthProvider {
  id: string;
  name: string;
  type: string;
}
