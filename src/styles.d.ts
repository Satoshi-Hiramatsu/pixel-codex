declare module '*.css';
declare module '*.png' {
  const url: string;
  export default url;
}

declare module 'electron-squirrel-startup' {
  const started: boolean;
  export default started;
}
