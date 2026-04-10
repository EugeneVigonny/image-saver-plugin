export type BlobDownloadFailure = Readonly<{
  ok: false;
  status: number;
  code?: string;
  message: string;
}>;

export type BlobDownloadSuccess = Readonly<{
  ok: true;
  blob: Blob;
}>;

export type BlobDownloadResult = BlobDownloadSuccess | BlobDownloadFailure;

export type DownloadImageBlobInput = Readonly<{
  image_url: string;
  source_page_url?: string;
}>;

export interface ImageSourceBlobPort {
  download(input: DownloadImageBlobInput): Promise<BlobDownloadResult>;
}
