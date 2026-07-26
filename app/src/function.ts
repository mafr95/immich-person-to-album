import { Link, Config } from './types'
import { addAssetsToAlbum, searchAssets } from '@immich/sdk'
import store from './store'
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

  async processPerson (link: Link) {
    let nextPage: string | null = '1'
    let mostRecent: string | undefined

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
      console.log(`Adding photos with ${operation} operation for persons [${searchPersonIds.join(', ')}] to album ${link.albumId}`)
    } else {
      console.log(`Adding person ${searchPersonIds[0]} to album ${link.albumId}`)
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

    const updatedAfter = store.get(this.getUpdateKeyName(link))
    let filteredAssets: any[] = []

    const applyPostFilters = (assets: any[]) => {
      let result = assets
      if (link.excludePersonIds && link.excludePersonIds.length > 0) {
        result = result.filter(asset => {
          const assetPersonIds = asset.people?.map((p: { id: string }) => p.id) || []
          return !link.excludePersonIds!.some((personId: string) => assetPersonIds.includes(personId))
        })
      }
      if (link.excludeOthers) {
        const specifiedPersonIds = new Set(searchPersonIds)
        result = result.filter(asset => {
          const assetPersonIds = asset.people?.map((p: { id: string }) => p.id) || []
          return assetPersonIds.every((id: string) => specifiedPersonIds.has(id))
        })
      }
      return result
    }

    const updateMostRecent = (assets: any[]) => {
      for (const asset of assets) {
        if (!asset.updatedAt) continue
        if (!mostRecent || new Date(asset.updatedAt).getTime() > new Date(mostRecent).getTime()) {
          mostRecent = asset.updatedAt
        }
      }
    }

    if (operation === 'OR' && searchPersonIds.length > 1) {
      const uniqAssets = new Map<string, any>()
      for (const personId of searchPersonIds) {
        let page: string | null = '1'

        while (page !== null) {
          console.log(` - Processing page ${page} for person ${personId}`)
          const res = await searchAssets({
            metadataSearchDto: {
              updatedAfter,
              page: parseInt(page, 10),
              personIds: [personId],
              withPeople: true
            }
          })

          for (const asset of res.assets.items) {
            uniqAssets.set(asset.id, asset)
          }

          updateMostRecent(res.assets.items)
          page = res.assets.nextPage
        }
      }

      filteredAssets = applyPostFilters(Array.from(uniqAssets.values()))
    } else {
      while (nextPage !== null) {
        console.log(` - Processing page ${nextPage}`)
        
        const res = await searchAssets({
          metadataSearchDto: {
            updatedAfter,
            page: parseInt(nextPage, 10),
            personIds: searchPersonIds,
            withPeople: true
          }
        })
        
        if (!mostRecent && res.assets.items.length > 0) {
          mostRecent = res.assets.items[0].updatedAt
        }

        filteredAssets = res.assets.items

        if (operation === 'AND' && searchPersonIds.length > 1) {
          filteredAssets = filteredAssets.filter(asset => {
            const assetPersonIds = asset.people?.map((p: { id: string }) => p.id) || []
            return searchPersonIds.every(personId => assetPersonIds.includes(personId))
          })
        }

        filteredAssets = applyPostFilters(filteredAssets)

        if (filteredAssets.length > 0) {
          await addAssetsToAlbum({
            id: link.albumId,
            bulkIdsDto: {
              ids: filteredAssets.map(x => x.id)
            }
          })
          console.log(`   Added ${filteredAssets.length} assets`)
        } else {
          console.log(`   No assets matched criteria`)
        }

        nextPage = res.assets.nextPage
      }
    }

    if (operation === 'OR' && searchPersonIds.length > 1) {
      if (filteredAssets.length > 0) {
        await addAssetsToAlbum({
          id: link.albumId,
          bulkIdsDto: {
            ids: filteredAssets.map(x => x.id)
          }
        })
        console.log(`   Added ${filteredAssets.length} assets`)
      } else {
        console.log(`   No assets matched criteria`)
      }
    }

    // Store the most recent asset update value
    if (mostRecent) {
      await store.set(this.getUpdateKeyName(link), mostRecent)
    }
    console.log()
  }

  /**
   * Get the correctly formatted key name for most-recent updated value in the store
   */
  getUpdateKeyName (link: Link) {
    const personKey = link.personIds && link.personIds.length > 0
      ? link.personIds.sort().join(',')
      : link.personId || ''
    const operation = link.operation || 'OR'
    const excludeOthers = link.excludeOthers ? 'exclusive' : ''
    return [link.apiKeyShort, personKey, operation, excludeOthers, link.albumId].join(':')
  }
}