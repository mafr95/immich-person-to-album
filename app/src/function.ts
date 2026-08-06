import { Link, Config } from './types'
import { addAssetsToAlbum, getAlbumInfo, removeAssetFromAlbum, searchAssets, AssetResponseDto } from '@immich/sdk'
import path from 'path'

export class PersonToAlbum {
  config: Config

  constructor () {
    this.initConfig()
  }

  /**
   * Format API errors with full details for debugging
   */
  private formatApiError (error: any): string {
    if (!error) return 'Unknown error'

    if (error.data?.errors) {
      const errors = Array.isArray(error.data.errors) ? error.data.errors : [error.data.errors]
      const details = errors.map((err: any) => {
        if (typeof err === 'string') return err
        if (err.messages) return `[${err.property}] ${err.messages.join(', ')}`
        return JSON.stringify(err)
      }).join(' | ')
      return `API Error (${error.status}): ${error.data.message} - ${details}`
    }

    if (error.data?.message) {
      return `API Error (${error.status}): ${error.data.message}`
    }

    return `API Error (${error.status}): ${JSON.stringify(error.data || error.message || error)}`
  }

  /**
   * Check if a string is a valid UUID
   */
  private isValidUUID (value: string): boolean {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    return uuidRegex.test(value)
  }

  /**
   * Read the config.json file or parse the CONFIG env value to get the configuration
   */
  initConfig () {
    try {
      if (process.env.CONFIG) {
        // Attempt to parse docker-compose config string into JSON (if specified)
        this.config = JSON.parse(process.env.CONFIG)
      } else {
        const configJson = require(path.resolve('../data/config.json'))
        if (typeof configJson === 'object') this.config = configJson
      }
    } catch (e) {
      console.log(e)
      console.log('Unable to parse config file.')
    }
  }

  /**
   * Apply the excludePersonIds / excludeOthers filters shared by both operation modes
   */
  private applyPostFilters (assets: AssetResponseDto[], link: Link, searchPersonIds: string[]) {
    let result = assets
    if (link.excludePersonIds && link.excludePersonIds.length > 0) {
      result = result.filter(asset => {
        const assetPersonIds = asset.people?.map(p => p.id) || []
        return !link.excludePersonIds!.some((personId: string) => assetPersonIds.includes(personId))
      })
    }
    if (link.excludeOthers) {
      const specifiedPersonIds = new Set(searchPersonIds)
      result = result.filter(asset => {
        const assetPersonIds = asset.people?.map(p => p.id) || []
        return assetPersonIds.every((id: string) => specifiedPersonIds.has(id))
      })
    }
    return result
  }

  /**
   * Walk every page of search results and return the complete set of assets which currently
   * match the link's criteria. This has to be a full (non-incremental) search, rather than only
   * checking recently-updated assets, so that assets which no longer match (e.g. a face was
   * deleted from a photo) can be detected and removed from the album.
   */
  private async getMatchingAssets (searchPersonIds: string[], operation: 'OR' | 'AND', link: Link): Promise<Map<string, AssetResponseDto>> {
    const matched = new Map<string, AssetResponseDto>()

    if (operation === 'OR' && searchPersonIds.length > 1) {
      for (const personId of searchPersonIds) {
        let page: string | null = '1'
        while (page !== null) {
          const res = await searchAssets({
            metadataSearchDto: {
              page: parseInt(page, 10),
              personIds: [personId],
              withPeople: true
            }
          })
          for (const asset of this.applyPostFilters(res.assets.items, link, searchPersonIds)) {
            matched.set(asset.id, asset)
          }
          page = res.assets.nextPage
        }
      }
    } else {
      let page: string | null = '1'
      while (page !== null) {
        const res = await searchAssets({
          metadataSearchDto: {
            page: parseInt(page, 10),
            personIds: searchPersonIds,
            withPeople: true
          }
        })

        let items = res.assets.items
        if (operation === 'AND' && searchPersonIds.length > 1) {
          items = items.filter(asset => {
            const assetPersonIds = asset.people?.map(p => p.id) || []
            return searchPersonIds.every(personId => assetPersonIds.includes(personId))
          })
        }

        for (const asset of this.applyPostFilters(items, link, searchPersonIds)) {
          matched.set(asset.id, asset)
        }
        page = res.assets.nextPage
      }
    }

    return matched
  }

  async processPerson (link: Link) {
    if (link.description) console.log(`=== ${link.description} ===`)

    // Get the person IDs to search for
    const searchPersonIds = link.personIds && link.personIds.length > 0
      ? link.personIds
      : [link.personId!]

    // Validate IDs
    const invalidPersonIds = searchPersonIds.filter(id => !this.isValidUUID(id))
    if (invalidPersonIds.length > 0) {
      throw new Error(`Invalid person ID(s): ${invalidPersonIds.join(', ')}. Expected UUID format.`)
    }

    if (!this.isValidUUID(link.albumId)) {
      throw new Error(`Invalid album ID: ${link.albumId}. Expected UUID format.`)
    }

    // Determine operation type (defaults to OR for backward compatibility)
    const operation = link.operation || 'OR'

    // Log the operation
    if (searchPersonIds.length > 1) {
      console.log(`Syncing photos with ${operation} operation for persons [${searchPersonIds.join(', ')}] to album ${link.albumId}`)
    } else {
      console.log(`Syncing person ${searchPersonIds[0]} to album ${link.albumId}`)
    }

    if (link.excludePersonIds && link.excludePersonIds.length > 0) {
      console.log(`Excluding persons: [${link.excludePersonIds.join(', ')}]`)
    }

    if (link.excludeOthers) {
      console.log(`Excluding all other people (only specified persons allowed)`)
      // Log warning if excludePersonIds is also specified (redundant)
      if (link.excludePersonIds && link.excludePersonIds.length > 0) {
        console.log(`Warning: excludePersonIds is redundant when excludeOthers is true`)
      }
    }

    // The full set of assets which currently match the link's criteria
    const matchedAssets = await this.getMatchingAssets(searchPersonIds, operation, link)

    // The album's current contents
    const album = await getAlbumInfo({ id: link.albumId })
    const currentAssetIds = new Set(album.assets.map(asset => asset.id))

    const toAdd = [...matchedAssets.keys()].filter(id => !currentAssetIds.has(id))
    const toRemove = [...currentAssetIds].filter(id => !matchedAssets.has(id))

    if (toAdd.length > 0) {
      await addAssetsToAlbum({
        id: link.albumId,
        bulkIdsDto: { ids: toAdd }
      })
      console.log(`   Added ${toAdd.length} assets`)
    }

    if (toRemove.length > 0) {
      await removeAssetFromAlbum({
        id: link.albumId,
        bulkIdsDto: { ids: toRemove }
      })
      console.log(`   Removed ${toRemove.length} assets which no longer match the criteria`)
    }

    if (toAdd.length === 0 && toRemove.length === 0) {
      console.log(`   Album already in sync`)
    }

    console.log()
  }
}
