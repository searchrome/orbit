// lunr is now loaded globally via script tag in index.html

class BookmarkManager {
  constructor() {
    this.bookmarks = JSON.parse(localStorage.getItem('bookmarks') || '[]');
    this.index = this.buildIndex();
  }

  /**
   * Creates Lunr search index from current bookmarks
   */
  buildIndex() {
    const currentBookmarks = this.bookmarks;
    return lunr(function() { 
      this.ref('id');
      this.field('title');
      this.field('summary');
      this.field('url');

      currentBookmarks.forEach((bookmark, id) => {
        this.add({ 
          id: id.toString(),
          title: bookmark.title,
          summary: bookmark.summary,
          url: bookmark.url
        });
      });
    });
  }

  addBookmark(bookmark) {
    this.bookmarks.push({
      ...bookmark,
      timestamp: Date.now()
    });
    localStorage.setItem('bookmarks', JSON.stringify(this.bookmarks));
    this.index = this.buildIndex();
  }

  search(query) {
    return this.index.search(query).map(result => {
      return { 
        ...this.bookmarks[result.ref], 
        score: result.score 
      };
    });
  }

  getAll() {
    return this.bookmarks;
  }

  /**
   * Toggle favorite status for a bookmark by URL.
   * Returns true if successful, false if not found.
   */
  toggleFavoriteByUrl(url) {
    const idx = this.bookmarks.findIndex(b => b.url === url);
    if (idx !== -1) {
      this.bookmarks[idx].favorite = !this.bookmarks[idx].favorite;
      localStorage.setItem('bookmarks', JSON.stringify(this.bookmarks));
      this.index = this.buildIndex();
      return true;
    }
    return false;
  }

  /**
   * Set favorite status for a bookmark by URL.
   * Returns true if successful, false if not found.
   */
  setFavoriteByUrl(url, isFavorite) {
    const idx = this.bookmarks.findIndex(b => b.url === url);
    if (idx !== -1) {
      this.bookmarks[idx].favorite = !!isFavorite;
      localStorage.setItem('bookmarks', JSON.stringify(this.bookmarks));
      this.index = this.buildIndex();
      return true;
    }
    return false;
  }
}

window.bookmarkManager = new BookmarkManager();
